package managedruntime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"

	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

// Native Codex requires separate namespace/name fields on Responses calls.
// Compatible models can instead return namespace.name (#144). Present ordinary
// MCP functions at the Provider codec, then restore exactly the offered address.
// This never accepts dotted aliases and does not change the Agent dispatcher.
type mcpNamespaceTranslation struct{}
type toolAddress struct{ namespace, name string }
type wireObject map[string]json.RawMessage

func textField(o wireObject, key string) string {
	var s string
	_ = json.Unmarshal(o[key], &s)
	return s
}
func setTextField(o wireObject, key, value string) { o[key], _ = json.Marshal(value) }
func encodeWire(v any) json.RawMessage             { b, _ := json.Marshal(v); return b }
func mcpAddress(o wireObject) (toolAddress, bool) {
	address := toolAddress{textField(o, "namespace"), textField(o, "name")}
	return address, strings.HasPrefix(address.namespace, "mcp__") && address.name != ""
}

// Length-prefix the namespace so embedded double underscores in either
// component cannot merge two native addresses. This is catalog-independent,
// keeping continuation history and deferred discovery on the same encoding.
// Compact names are deterministic and collision-resistant (not reversible).
func (a toolAddress) flat() string {
	namespace := strings.TrimPrefix(a.namespace, "mcp__")
	flat := "mcp__" + strconv.Itoa(len(namespace)) + "_" + namespace + "__" + a.name
	// Muse rejects function names above 64 characters (final142-a capture).
	// OpenAI's Chat FunctionDefinition also requires [a-zA-Z0-9_-], max 64:
	// https://developers.openai.com/api/reference/resources/evals/subresources/runs/methods/create
	if len(flat) <= 64 && strings.IndexFunc(flat, func(c rune) bool {
		return !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-')
	}) == -1 {
		return flat
	}
	// Hash the unambiguous full address, never a truncated or sanitized prefix.
	// Full SHA-256 preserves collision resistance; h cannot overlap the numeric
	// namespace-length prefix. Exact restoration uses only the offered catalog.
	digest := sha256.Sum256([]byte(flat))
	return "mcp__h_" + base64.RawURLEncoding.EncodeToString(digest[:])
}

func flattenMcpCatalog(root wireObject) map[string]toolAddress {
	addresses := map[string]toolAddress{}
	// Deferred tools are offered by the same native namespace serializer inside
	// tool_search_output, and must use the same names as the initial catalog.
	var input []wireObject
	if json.Unmarshal(root["input"], &input) == nil {
		for _, item := range input {
			if textField(item, "type") != "tool_search_output" {
				continue
			}
			for name, address := range flattenMcpCatalog(item) {
				addresses[name] = address
			}
		}
		if len(addresses) > 0 {
			root["input"] = encodeWire(input)
		}
	}
	var tools []wireObject
	if json.Unmarshal(root["tools"], &tools) != nil {
		return addresses
	}
	flat := make([]wireObject, 0, len(tools))
	for _, tool := range tools {
		namespace := textField(tool, "name")
		if textField(tool, "type") != "namespace" || !strings.HasPrefix(namespace, "mcp__") {
			flat = append(flat, tool)
			continue
		}
		var children []wireObject
		if json.Unmarshal(tool["tools"], &children) != nil {
			flat = append(flat, tool)
			continue
		}
		for _, child := range children {
			address := toolAddress{namespace, textField(child, "name")}
			addresses[address.flat()] = address
			setTextField(child, "name", address.flat())
			if description := textField(tool, "description"); description != "" {
				setTextField(child, "description", strings.TrimSpace(description+"\n"+textField(child, "description")))
			}
			flat = append(flat, child)
		}
	}
	if len(addresses) > 0 {
		root["tools"] = encodeWire(flat)
	}
	return addresses
}

func (mcpNamespaceTranslation) NormalizeRequest(_ context.Context, from, to sdktranslator.Format, _ string, body []byte, _ bool) []byte {
	if from != sdktranslator.FormatOpenAIResponse || to != sdktranslator.FormatCodex {
		return body
	}
	var root wireObject
	if json.Unmarshal(body, &root) != nil {
		return body
	}
	changed := len(flattenMcpCatalog(root)) > 0
	var input []wireObject
	if json.Unmarshal(root["input"], &input) == nil {
		for _, item := range input {
			if textField(item, "type") != "function_call" {
				continue
			}
			if address, ok := mcpAddress(item); ok {
				setTextField(item, "name", address.flat())
				delete(item, "namespace")
				changed = true
			}
		}
		root["input"] = encodeWire(input)
	}
	var choice wireObject
	if json.Unmarshal(root["tool_choice"], &choice) == nil {
		if address, ok := mcpAddress(choice); ok {
			setTextField(choice, "name", address.flat())
			delete(choice, "namespace")
			changed = true
			root["tool_choice"] = encodeWire(choice)
		}
	}
	if !changed {
		return body
	}
	return encodeWire(root)
}
func (mcpNamespaceTranslation) TranslateRequest(_ context.Context, _, _ sdktranslator.Format, _ string, _ []byte, _ bool) ([]byte, bool) {
	return nil, false
}

func (mcpNamespaceTranslation) NormalizeResponseBefore(_ context.Context, from, to sdktranslator.Format, _ string, original, _, body []byte, _ bool) []byte {
	if from != sdktranslator.FormatCodex || to != sdktranslator.FormatOpenAIResponse || !bytes.Contains(body, []byte("mcp__")) {
		return body
	}
	var request wireObject
	if json.Unmarshal(original, &request) != nil {
		return body
	}
	addresses := flattenMcpCatalog(request)
	if len(addresses) == 0 {
		return body
	}
	prefix := []byte(nil)
	payload := body
	if bytes.HasPrefix(body, []byte("data:")) {
		prefix = []byte("data: ")
		payload = bytes.TrimSpace(body[5:])
	}
	var root wireObject
	if json.Unmarshal(payload, &root) != nil {
		return body
	}
	changed := restoreMcpCalls(root, addresses)
	if !changed {
		return body
	}
	return append(prefix, encodeWire(root)...)
}
func restoreMcpCalls(root wireObject, addresses map[string]toolAddress) bool {
	changed := false
	if textField(root, "type") == "function_call" && textField(root, "namespace") == "" {
		if address, ok := addresses[textField(root, "name")]; ok {
			setTextField(root, "name", address.name)
			setTextField(root, "namespace", address.namespace)
			changed = true
		}
	}
	for _, key := range []string{"item", "response"} {
		var child wireObject
		if json.Unmarshal(root[key], &child) == nil && child != nil && restoreMcpCalls(child, addresses) {
			root[key] = encodeWire(child)
			changed = true
		}
	}
	var output []wireObject
	if json.Unmarshal(root["output"], &output) == nil {
		for _, item := range output {
			if restoreMcpCalls(item, addresses) {
				changed = true
			}
		}
		if changed {
			root["output"] = encodeWire(output)
		}
	}
	return changed
}
func (mcpNamespaceTranslation) TranslateResponse(_ context.Context, _, _ sdktranslator.Format, _ string, _, _, _ []byte, _ bool) ([]byte, bool) {
	return nil, false
}
func (mcpNamespaceTranslation) NormalizeResponseAfter(_ context.Context, _, _ sdktranslator.Format, _ string, _, _, body []byte, _ bool) []byte {
	return body
}
