package managedruntime

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"testing"

	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

// #144 seq15/16 returned mcp__happier.action_spec_search and Codex rejected it.
// The namespace catalog is captured from the installed Codex 0.162.1 Responses
// request; only the external model/HTTP peer and auth broker are substituted.
type namespaceModel struct {
	mu       sync.Mutex
	names    []string
	requests []json.RawMessage
}

func (m *namespaceModel) RoundTrip(req *http.Request) (*http.Response, error) {
	payload, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	var body struct {
		Input json.RawMessage
		Tools []struct {
			Type, Name string
			Tools      []struct{ Name string }
		}
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil, err
	}
	name := ""
	for _, tool := range body.Tools {
		if tool.Type == "namespace" && tool.Name == "mcp__happier" {
			name = tool.Name + "." + tool.Tools[0].Name
		}
		if tool.Type == "function" && strings.HasPrefix(tool.Name, "mcp__") {
			name = tool.Name
		}
	}
	m.mu.Lock()
	m.names = append(m.names, name)
	m.requests = append(m.requests, payload)
	m.mu.Unlock()
	item := map[string]any{"type": "function_call", "id": "fc_144", "call_id": "call_01a1d2e5e25c76f399c8cfb81136ee3c", "name": name, "arguments": `{"query":"store","limit":20}`, "status": "completed"}
	if strings.Contains(string(body.Input), "function_call_output") {
		item = map[string]any{"type": "message", "id": "msg_144", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": "DONE", "annotations": []any{}}}}
	}
	result := map[string]any{"id": "resp_144", "object": "response", "status": "completed", "output": []any{item}, "usage": map[string]int{"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
	var lines []string
	for _, event := range []map[string]any{
		{"type": "response.created", "response": map[string]any{"id": "resp_144", "status": "in_progress", "output": []any{}}},
		{"type": "response.output_item.added", "output_index": 0, "item": item},
		{"type": "response.output_item.done", "output_index": 0, "item": item},
		{"type": "response.completed", "response": result},
	} {
		encoded, _ := json.Marshal(event)
		lines = append(lines, "event: "+event["type"].(string)+"\ndata: "+string(encoded)+"\n\n")
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(strings.Join(lines, ""))), Request: req}, nil
}
func TestCodexMcpNamespaceRoundTrip(t *testing.T) {
	for _, toolName := range []string{"action_spec_search", "connected_services_authentication_continue_connect"} {
		t.Run(toolName, func(t *testing.T) {
			for _, provider := range []Provider{ProviderMeta, ProviderCodex} {
				for _, stream := range []bool{true, false} {
					t.Run(fmt.Sprint(provider, "/", stream), func(t *testing.T) {
						testCase := metaProtocolCases()[1]
						if provider == ProviderCodex {
							testCase.provider = provider
							testCase.purpose = "openai-upstream"
							testCase.model = "gpt-6.1-sol"
						}
						cfg := crossProtocolConfig(t, testCase)
						model := &namespaceModel{}
						gateway, err := NewGateway(cfg, testRuntimeIdentity(), &sequenceBroker{leases: []RequestAuthHeaders{validLease("fixture-only", nil)}}, model)
						if err != nil {
							t.Fatal(err)
						}
						cancel, result := runGateway(t, gateway)
						defer stopGateway(t, cancel, result)
						_ = awaitManagedHealthIdentity(t, cfg)
						request := fmt.Sprintf(`{"model":%q,"stream":%t,"input":"list store Action specs","tools":[{"type":"namespace","name":"mcp__happier","description":"Happier MCP","tools":[{"type":"function","name":%q,"parameters":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}}}}]}]}`, testCase.model, stream, toolName)
						response := postJSON(t, cfg, "/v1/responses", request)
						body := readResponse(t, response)
						_ = response.Body.Close()
						if response.StatusCode != 200 {
							t.Fatalf("response %d: %s", response.StatusCode, body)
						}
						if len(model.names) != 1 || !regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`).MatchString(model.names[0]) {
							t.Fatalf("presented names = %v; expected flat MCP function", model.names)
						}
						for _, fragment := range []string{`"namespace":"mcp__happier"`, fmt.Sprintf(`"name":%q`, toolName), `call_01a1d2e5e25c76f399c8cfb81136ee3c`} {
							if !strings.Contains(body, fragment) {
								t.Fatalf("Codex response missing %s: %s", fragment, body)
							}
						}
					})
				}
			}
		})
	}
}

// Uses the real installed native decoder, an isolated empty home and the real
// managed gateway. Opt-in because a platform Codex executable is external input.
func TestNativeCodexMcpNamespaceRoundTrip(t *testing.T) {
	binary := os.Getenv("HAPPIER_TEST_NATIVE_CODEX")
	if binary == "" {
		t.Skip("set HAPPIER_TEST_NATIVE_CODEX to an installed Codex executable")
	}
	homeRoot := os.Getenv("HAPPIER_TEST_NATIVE_CODEX_HOME")
	if homeRoot == "" {
		t.Skip("set HAPPIER_TEST_NATIVE_CODEX_HOME to a retained directory outside executor scratch")
	}
	if err := os.MkdirAll(homeRoot, 0700); err != nil {
		t.Fatal(err)
	}
	home, err := os.MkdirTemp(homeRoot, "happier-codex-mcp-")
	if err != nil {
		t.Fatal(err)
	}
	// Native transcripts are deliberately retained; never remove this directory.
	t.Logf("native Codex home (retained): %s", home)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cfg := crossProtocolConfig(t, metaProtocolCases()[1])
	model := &namespaceModel{}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), &sequenceBroker{leases: []RequestAuthHeaders{validLease("fixture-only", nil), validLease("fixture-only", nil)}}, model)
	if err != nil {
		t.Fatal(err)
	}
	cancel, result := runGateway(t, gateway)
	defer stopGateway(t, cancel, result)
	_ = awaitManagedHealthIdentity(t, cfg)
	overrides := []string{
		`model="muse-spark-1.3"`, `model_provider="fixture"`,
		fmt.Sprintf(`model_providers.fixture={name="fixture",base_url="http://127.0.0.1:%d/v1",wire_api="responses",http_headers={Authorization="Bearer %s"}}`, cfg.Port, cfg.DownstreamBearer),
		fmt.Sprintf(`mcp_servers.happier.command=%q`, executable),
		`mcp_servers.happier.args=["-test.run=^TestCodexMcpFixtureProcess$"]`,
		`mcp_servers.happier.env={HAPPIER_MCP_FIXTURE_PROCESS="1"}`,
		`mcp_servers.happier.required=true`,
		`mcp_servers.happier.tools.action_spec_search.approval_mode="approve"`,
	}
	args := []string{"exec", "--json", "--skip-git-repo-check"}
	for _, override := range overrides {
		args = append(args, "-c", override)
	}
	args = append(args, "List store Action specs through happier MCP. Do not use shell.")
	command := exec.Command(binary, args...)
	command.Dir = home
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "CODEX_HOME=" + home}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("native Codex: %v: %s", err, output)
	}
	model.mu.Lock()
	defer model.mu.Unlock()
	if len(model.requests) != 2 || !strings.Contains(string(model.requests[1]), "ACTION_SPECS_OK") {
		t.Fatalf("native decoder failed to reach MCP: requests=%s output=%s", model.requests, output)
	}
	if strings.Contains(string(model.requests[1]), `"namespace":"mcp__happier"`) {
		t.Fatalf("history was not flattened: %s", model.requests[1])
	}
	for _, name := range model.names {
		if name != "mcp__7_happier__action_spec_search" {
			t.Fatalf("model-facing name = %q", name)
		}
	}
}

func TestCodexMcpFixtureProcess(t *testing.T) {
	if os.Getenv("HAPPIER_MCP_FIXTURE_PROCESS") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage
			Method string
			Params struct{ ProtocolVersion string }
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			t.Fatal(err)
		}
		if len(request.ID) == 0 {
			continue
		}
		var result any = map[string]any{}
		switch request.Method {
		case "initialize":
			result = map[string]any{"protocolVersion": request.Params.ProtocolVersion, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "recorded-mcp-fixture", "version": "1"}}
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{"name": "action_spec_search", "description": "Search Action specs", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"query": map[string]string{"type": "string"}, "limit": map[string]string{"type": "integer"}}}}}}
		case "tools/call":
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "ACTION_SPECS_OK"}}}
		}
		if err := encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMcpNamespaceContinuationWithoutRepeatedCatalog(t *testing.T) {
	request := []byte(`{"input":[{"type":"function_call","call_id":"call_144","namespace":"mcp__happier","name":"action_spec_search","arguments":"{}"},{"type":"function_call_output","call_id":"call_144","output":"ACTION_SPECS_OK"}],"tool_choice":{"type":"function","namespace":"mcp__happier","name":"action_spec_search"}}`)
	translated := mcpNamespaceTranslation{}.NormalizeRequest(context.Background(), sdktranslator.FormatOpenAIResponse, sdktranslator.FormatCodex, "muse-spark-1.3", request, true)
	if strings.Contains(string(translated), `"namespace"`) || !strings.Contains(string(translated), `"name":"mcp__7_happier__action_spec_search"`) || !strings.Contains(string(translated), "ACTION_SPECS_OK") {
		t.Fatalf("continuation lost flat-name correlation: %s", translated)
	}
}

func TestMcpNamespacePreservesOtherToolsAndUnofferedCalls(t *testing.T) {
	request := []byte(`{"tools":[{"type":"function","name":"ordinary","parameters":{}},{"type":"namespace","name":"happier_host","tools":[{"type":"function","name":"shell_command","parameters":{}}]},{"type":"namespace","name":"mcp__happier","tools":[{"type":"function","name":"action_spec_search","defer_loading":true,"parameters":{}}]}]}`)
	hook := mcpNamespaceTranslation{}
	translated := hook.NormalizeRequest(context.Background(), sdktranslator.FormatOpenAIResponse, sdktranslator.FormatCodex, "muse-spark-1.3", request, true)
	for _, fragment := range []string{`"name":"ordinary"`, `"name":"happier_host"`, `"name":"shell_command"`, `"defer_loading":true`} {
		if !strings.Contains(string(translated), fragment) {
			t.Fatalf("lost tool contract %s: %s", fragment, translated)
		}
	}
	for _, name := range []string{"mcp__happier.action_spec_search", "mcp__happier__action_spec_search", "mcp__happier__unoffered"} {
		response := []byte(fmt.Sprintf(`{"type":"response.output_item.done","item":{"type":"function_call","name":%q,"arguments":"{}"}}`, name))
		got := hook.NormalizeResponseBefore(context.Background(), sdktranslator.FormatCodex, sdktranslator.FormatOpenAIResponse, "muse-spark-1.3", request, translated, response, true)
		if string(got) != string(response) {
			t.Fatalf("accepted unoffered alias %s: %s", name, got)
		}
	}
}

// Codex 0.162.1's tool_search_output carries the same namespace catalog; pinned
// v8.0.61's Claude Responses tool-search vectors record this native shape.
func TestMcpNamespaceDeferredDiscovery(t *testing.T) {
	request := []byte(`{"input":[{"type":"tool_search_output","call_id":"search_1","status":"completed","execution":"client","tools":[{"type":"namespace","name":"mcp__happier","tools":[{"type":"function","name":"action_spec_search","defer_loading":true,"parameters":{}}]}]}]}`)
	hook := mcpNamespaceTranslation{}
	translated := hook.NormalizeRequest(context.Background(), sdktranslator.FormatOpenAIResponse, sdktranslator.FormatCodex, "muse-spark-1.3", request, true)
	if strings.Contains(string(translated), `"type":"namespace"`) || !strings.Contains(string(translated), `"name":"mcp__7_happier__action_spec_search"`) {
		t.Fatalf("deferred catalog remains namespaced: %s", translated)
	}
	response := []byte(`{"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_144","name":"mcp__7_happier__action_spec_search","arguments":"{}"}}`)
	restored := hook.NormalizeResponseBefore(context.Background(), sdktranslator.FormatCodex, sdktranslator.FormatOpenAIResponse, "muse-spark-1.3", request, translated, response, true)
	if !strings.Contains(string(restored), `"namespace":"mcp__happier"`) || !strings.Contains(string(restored), `"name":"action_spec_search"`) {
		t.Fatalf("deferred tool identity lost: %s", restored)
	}
}

// Different native addresses must remain reachable even when joining them with
// double underscores would produce the same model-facing name.
func TestMcpNamespaceInjectiveFlatNames(t *testing.T) {
	for _, deferred := range []bool{false, true} {
		t.Run(fmt.Sprint("deferred=", deferred), func(t *testing.T) {
			catalog := `[{"type":"namespace","name":"mcp__a","tools":[{"type":"function","name":"b__c","parameters":{}}]},{"type":"namespace","name":"mcp__a__b","tools":[{"type":"function","name":"c","parameters":{}}]}]`
			request := []byte(`{"tools":` + catalog + `,"input":[{"type":"function_call","namespace":"mcp__a","name":"b__c","call_id":"first","arguments":"{}"}],"tool_choice":{"type":"function","namespace":"mcp__a__b","name":"c"}}`)
			if deferred {
				request = []byte(`{"input":[{"type":"tool_search_output","tools":` + catalog + `}]}`)
			}
			hook := mcpNamespaceTranslation{}
			translated := hook.NormalizeRequest(context.Background(), sdktranslator.FormatOpenAIResponse, sdktranslator.FormatCodex, "muse-spark-1.3", request, true)
			var root wireObject
			_ = json.Unmarshal(translated, &root)
			var tools []wireObject
			if deferred {
				var input []wireObject
				_ = json.Unmarshal(root["input"], &input)
				root = input[0]
			}
			_ = json.Unmarshal(root["tools"], &tools)
			if len(tools) != 2 || textField(tools[0], "name") == textField(tools[1], "name") {
				t.Fatalf("distinct offered addresses collided: %s", translated)
			}
			for i, address := range []toolAddress{{"mcp__a", "b__c"}, {"mcp__a__b", "c"}} {
				response := encodeWire(wireObject{"type": encodeWire("function_call"), "name": tools[i]["name"], "arguments": encodeWire("{}")})
				restored := hook.NormalizeResponseBefore(context.Background(), sdktranslator.FormatCodex, sdktranslator.FormatOpenAIResponse, "muse-spark-1.3", request, translated, response, true)
				var call wireObject
				_ = json.Unmarshal(restored, &call)
				if textField(call, "namespace") != address.namespace || textField(call, "name") != address.name {
					t.Fatalf("wrong restored address %d: %s", i, restored)
				}
			}
			if !deferred {
				_ = json.Unmarshal(translated, &root)
				var input []wireObject
				_ = json.Unmarshal(root["input"], &input)
				var choice wireObject
				_ = json.Unmarshal(root["tool_choice"], &choice)
				if textField(input[0], "name") != textField(tools[0], "name") || textField(choice, "name") != textField(tools[1], "name") {
					t.Fatalf("history/choice diverged from catalog: %s", translated)
				}
			}
		})
	}
}

// Longest current Happier MCP binding (bindings.mcpToolName), projected
// through the CLI Happier tool inventory; source: protocol/actions/specs/connectedServices.ts.
// Test the actual request boundary, including deferred catalogs and continuation.
func TestMcpNamespaceVendorFunctionNameContract(t *testing.T) {
	addresses := []toolAddress{
		{"mcp__happier", "connected_services_authentication_continue_connect"},
		{"mcp__happier", strings.Repeat("x", 200)},
		{"mcp__happier", strings.Repeat("x", 199) + "y"},
		{"mcp__has.dots", "tool/name-雪"},
		{"mcp__happier", strings.Repeat("b", 48)}, // exactly 64 before compaction
		{"mcp__happier", strings.Repeat("b", 49)},
	}
	valid := regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
	hook := mcpNamespaceTranslation{}
	for _, deferred := range []bool{false, true} {
		t.Run(fmt.Sprint("deferred=", deferred), func(t *testing.T) {
			seen := map[string]bool{}
			for _, address := range addresses {
				t.Run(address.name, func(t *testing.T) {
					catalog := []any{map[string]any{"type": "namespace", "name": address.namespace, "tools": []any{map[string]any{"type": "function", "name": address.name, "parameters": map[string]any{}}}}}
					root := map[string]any{"tools": catalog, "input": []any{map[string]any{"type": "function_call", "namespace": address.namespace, "name": address.name, "arguments": "{}"}}, "tool_choice": map[string]any{"type": "function", "namespace": address.namespace, "name": address.name}}
					if deferred {
						root["input"] = []any{map[string]any{"type": "tool_search_output", "tools": catalog}}
						delete(root, "tools")
					}
					request := encodeWire(root)
					translated := hook.NormalizeRequest(context.Background(), sdktranslator.FormatOpenAIResponse, sdktranslator.FormatCodex, "muse-spark-1.3", request, true)
					var normalized wireObject
					_ = json.Unmarshal(translated, &normalized)
					var input []wireObject
					_ = json.Unmarshal(normalized["input"], &input)
					catalogRoot := normalized
					if deferred {
						catalogRoot = input[0]
					}
					var tools []wireObject
					_ = json.Unmarshal(catalogRoot["tools"], &tools)
					flat := textField(tools[0], "name")
					if !valid.MatchString(flat) {
						t.Fatalf("vendor rejects offered function name (%d bytes): %q", len(flat), flat)
					}
					if seen[flat] {
						t.Fatalf("different native addresses collided: %q", flat)
					}
					seen[flat] = true
					if !deferred {
						var choice wireObject
						_ = json.Unmarshal(normalized["tool_choice"], &choice)
						if textField(input[0], "name") != flat || textField(choice, "name") != flat {
							t.Fatalf("history/choice differ from offered name: %s", translated)
						}
						delete(root, "tools")
						continuation := hook.NormalizeRequest(context.Background(), sdktranslator.FormatOpenAIResponse, sdktranslator.FormatCodex, "muse-spark-1.3", encodeWire(root), true)
						if !strings.Contains(string(continuation), flat) {
							t.Fatalf("catalog-independent continuation diverged: %s", continuation)
						}
					}
					for _, stream := range []bool{false, true} {
						response := encodeWire(map[string]any{"type": "response.output_item.done", "item": map[string]any{"type": "function_call", "name": flat, "arguments": "{}"}})
						if stream {
							response = append([]byte("data: "), response...)
						}
						restored := hook.NormalizeResponseBefore(context.Background(), sdktranslator.FormatCodex, sdktranslator.FormatOpenAIResponse, "muse-spark-1.3", request, translated, response, stream)
						var event struct {
							Item struct{ Namespace, Name string }
						}
						_ = json.Unmarshal([]byte(strings.TrimPrefix(string(restored), "data: ")), &event)
						if event.Item.Namespace != address.namespace || event.Item.Name != address.name {
							t.Fatalf("exact address not restored: %s", restored)
						}
					}
					alias := encodeWire(map[string]any{"type": "function_call", "name": address.namespace + "." + address.name})
					if got := hook.NormalizeResponseBefore(context.Background(), sdktranslator.FormatCodex, sdktranslator.FormatOpenAIResponse, "muse-spark-1.3", request, translated, alias, false); string(got) != string(alias) {
						t.Fatalf("accepted dotted alias: %s", got)
					}
				})
			}
		})
	}
}
