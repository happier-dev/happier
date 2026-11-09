package managedruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestManagedGeminiUsesAPIKeyExecutorRegistration(t *testing.T) {
	entry := testAuthEntry("gemini", Provider("gemini"), "gemini-upstream")
	entry.AllowedHTTPSOrigins = []string{"https://generativelanguage.googleapis.com"}
	if err := entry.validate(); err != nil {
		t.Fatalf("Gemini key family must be admitted: %v", err)
	}
	auth := managedRuntimeAuth(entry)
	if auth.Attributes["api_key"] == "" || auth.Metadata["access_token"] != nil {
		t.Fatal("Gemini must use the API-key executor branch without OAuth metadata")
	}
}

func geminiProtocolCases() []crossProtocolCase {
	cases := crossProtocolCases()
	for index := range cases {
		old := cases[index].model
		cases[index].name = string(cases[index].protocol)
		cases[index].provider = ProviderGemini
		cases[index].purpose = "gemini-upstream"
		cases[index].host = "generativelanguage.googleapis.com"
		cases[index].model = "gemini-2.5-flash"
		cases[index].request = strings.ReplaceAll(cases[index].request, old, cases[index].model)
		cases[index].continuation = strings.ReplaceAll(cases[index].continuation, old, cases[index].model)
		switch cases[index].protocol {
		case ProtocolAnthropic:
			cases[index].request = strings.Replace(cases[index].request, `"content":"use the tool"`, `"content":[{"type":"text","text":"use the tool"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}]`, 1)
		case ProtocolOpenAIChat:
			cases[index].request = strings.Replace(cases[index].request, `"content":"use the tool"`, `"content":[{"type":"text","text":"use the tool"},{"type":"image_url","image_url":{"url":"data:image/png;base64,aGVsbG8="}}]`, 1)
		case ProtocolOpenAIResponses:
			cases[index].request = strings.Replace(cases[index].request, `"input":"use the tool"`, `"input":[{"role":"user","content":[{"type":"input_text","text":"use the tool"},{"type":"input_image","image_url":"data:image/png;base64,aGVsbG8="}]}]`, 1)
		}
	}
	return cases
}

func geminiRequestAuth(key string) RequestAuthHeaders {
	material := validLease("unused-bearer", nil)
	material.Headers = map[string]string{"x-goog-api-key": key}
	material.CredentialContext.Account.Service = ContributionIdentity{PluginID: "happier.agent.gemini", LocalID: "gemini-account"}
	return material
}

// Only the request-auth broker and remote HTTP response are fake. The gateway,
// manager, pinned v8.0.61 Gemini executor, and protocol translators stay real.
func TestManagedGeminiTranslatesStreamingToolsAndContinuation(t *testing.T) {
	for _, testCase := range geminiProtocolCases() {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := crossProtocolConfig(t, testCase)
			broker := &sequenceBroker{leases: []RequestAuthHeaders{geminiRequestAuth("first-key"), geminiRequestAuth("second-key")}}
			upstream := &geminiFixtureRoundTripper{}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, result := runGateway(t, gateway)
			defer stopGateway(t, cancel, result)
			_ = awaitManagedHealthIdentity(t, cfg)
			if len(broker.purposes()) != 0 || len(upstream.requests()) != 0 {
				t.Fatal("Gemini startup acquired credentials or made an upstream request")
			}
			for _, model := range gateway.Catalog() {
				if model.Provider != ProviderGemini {
					t.Fatalf("unbound catalog family: %#v", model)
				}
			}
			response := postJSON(t, cfg, testCase.path, testCase.request)
			body := readResponse(t, response)
			_ = response.Body.Close()
			for _, fragment := range []string{testCase.terminal, testCase.toolKind, "fixture_tool", "fixture-thought", "fixture-text"} {
				if response.StatusCode != http.StatusOK || !strings.Contains(body, fragment) {
					t.Fatalf("Gemini stream omitted %q: status=%d body=%s", fragment, response.StatusCode, body)
				}
			}
			// Argument fragments must survive independently framed upstream events.
			if !strings.Contains(body, "value") || !strings.Contains(body, "ok") || !strings.Contains(body, "tokens") {
				t.Fatalf("Gemini lost arguments or usage: %s", body)
			}
			callID := geminiTranslatedToolCallID(body)
			if callID == "" {
				t.Fatalf("Gemini tool call has no downstream correlation ID: %s", body)
			}
			response = postJSON(t, cfg, testCase.path, strings.ReplaceAll(testCase.continuation, "call_1", callID))
			body = readResponse(t, response)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusOK || !strings.Contains(body, "fixture-final") || !strings.Contains(body, "tokens") {
				t.Fatalf("Gemini continuation failed: %d %s", response.StatusCode, body)
			}
			requests := upstream.requests()
			if len(requests) != 2 || len(broker.purposes()) != 2 {
				t.Fatalf("attempts/borrows = %d/%d, want 2/2", len(requests), len(broker.purposes()))
			}
			for index, request := range requests {
				assertGeminiWire(t, request, []string{"first-key", "second-key"}[index])
				payload, err := io.ReadAll(request.Body)
				if err != nil {
					t.Fatal(err)
				}
				if index == 0 && (!strings.HasSuffix(request.URL.Path, ":streamGenerateContent") || !strings.Contains(string(payload), "functionDeclarations") || !strings.Contains(string(payload), "image/png") || !strings.Contains(string(payload), "aGVsbG8=")) {
					t.Fatalf("Gemini streaming tool wire missing: %s %s", request.URL, payload)
				}
				if index == 1 && (!strings.HasSuffix(request.URL.Path, ":generateContent") || !strings.Contains(string(payload), "functionResponse") || !strings.Contains(string(payload), "fixture-result") || !strings.Contains(string(payload), "fixture_tool")) {
					t.Fatalf("Gemini tool result correlation missing: %s %s", request.URL, payload)
				}
			}
			for _, purpose := range broker.purposes() {
				if purpose != testPurpose("gemini-upstream") {
					t.Fatalf("unbound borrow: %#v", purpose)
				}
			}
			assertNoRuntimeStateFiles(t, cfg.RuntimeDir)
		})
	}
}

func TestManagedGeminiNonStreamingToolResponse(t *testing.T) {
	for _, testCase := range geminiProtocolCases() {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := crossProtocolConfig(t, testCase)
			broker := &sequenceBroker{leases: []RequestAuthHeaders{geminiRequestAuth("tool-key")}}
			upstream := &geminiFixtureRoundTripper{responseOverride: `{"candidates":[{"index":0,"content":{"role":"model","parts":[{"thought":true,"text":"fixture-thought"},{"text":"fixture-text"},{"functionCall":{"id":"call_1","name":"fixture_tool","args":{"value":"ok"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"thoughtsTokenCount":2,"totalTokenCount":12}}`}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, result := runGateway(t, gateway)
			defer stopGateway(t, cancel, result)
			_ = awaitManagedHealthIdentity(t, cfg)
			response := postJSON(t, cfg, testCase.path, strings.Replace(testCase.request, `"stream":true`, `"stream":false`, 1))
			body := readResponse(t, response)
			_ = response.Body.Close()
			for _, fragment := range []string{"fixture_tool", "fixture-thought", "fixture-text", "value", "ok", "tokens"} {
				if response.StatusCode != http.StatusOK || !strings.Contains(body, fragment) {
					t.Fatalf("Gemini nonstream lost %q: %d %s", fragment, response.StatusCode, body)
				}
			}
			if len(broker.purposes()) != 1 || len(upstream.requests()) != 1 {
				t.Fatal("Gemini nonstream must borrow once per attempt")
			}
			assertGeminiWire(t, upstream.requests()[0], "tool-key")
		})
	}
}

func TestManagedGeminiInlineMediaAndCountTokens(t *testing.T) {
	testCase := geminiProtocolCases()[0]
	cfg := crossProtocolConfig(t, testCase)
	broker := &sequenceBroker{leases: []RequestAuthHeaders{geminiRequestAuth("media-key"), geminiRequestAuth("count-key")}}
	upstream := &geminiFixtureRoundTripper{}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatal(err)
	}
	cancel, result := runGateway(t, gateway)
	defer stopGateway(t, cancel, result)
	_ = awaitManagedHealthIdentity(t, cfg)
	input := `{"model":"gemini-2.5-flash","max_tokens":64,"messages":[{"role":"user","content":[{"type":"text","text":"describe"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}]}]}`
	for _, path := range []string{"/v1/messages", "/v1/messages/count_tokens"} {
		response := postJSON(t, cfg, path, input)
		body := readResponse(t, response)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("Gemini media/count failed: %d %s", response.StatusCode, body)
		}
		if strings.HasSuffix(path, "count_tokens") && !strings.Contains(body, `"input_tokens":17`) {
			t.Fatalf("wrong count: %s", body)
		}
	}
	requests := upstream.requests()
	if len(requests) != 2 || len(broker.purposes()) != 2 {
		t.Fatalf("generate/count attempts/borrows = %d/%d", len(requests), len(broker.purposes()))
	}
	for index, request := range requests {
		assertGeminiWire(t, request, []string{"media-key", "count-key"}[index])
		payload, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(payload), "image/png") || !strings.Contains(string(payload), "aGVsbG8=") {
			t.Fatalf("inline media lost: %s", payload)
		}
		if index == 1 && !strings.HasSuffix(request.URL.Path, ":countTokens") {
			t.Fatalf("count used wrong executor: %s", request.URL)
		}
	}
}

func TestManagedGeminiErrorsDoNotReplayOrChangeAccounts(t *testing.T) {
	for _, testCase := range geminiProtocolCases() {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := crossProtocolConfig(t, testCase)
			material := geminiRequestAuth("error-key")
			broker := &sequenceBroker{leases: []RequestAuthHeaders{material, material, material, material}}
			upstream := &geminiFixtureRoundTripper{statuses: []int{401, 403, 429, 500}}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, result := runGateway(t, gateway)
			defer stopGateway(t, cancel, result)
			_ = awaitManagedHealthIdentity(t, cfg)
			for _, status := range upstream.statuses {
				response := postJSON(t, cfg, testCase.path, testCase.request)
				body := readResponse(t, response)
				_ = response.Body.Close()
				if response.StatusCode != status || !strings.Contains(body, "fixture failure") {
					t.Fatalf("error precedence lost: %d %s, want %d", response.StatusCode, body, status)
				}
			}
			if len(upstream.requests()) != 4 || len(broker.purposes()) != 4 || len(broker.authFailures) != 1 || len(broker.quotaFailures) != 2 {
				t.Fatalf("errors/replays = %d attempts, %d borrows, %d auth, %d quota", len(upstream.requests()), len(broker.purposes()), len(broker.authFailures), len(broker.quotaFailures))
			}
		})
	}
}

func TestManagedGeminiCancellationStopsSelectedAttempt(t *testing.T) {
	for _, testCase := range geminiProtocolCases() {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := crossProtocolConfig(t, testCase)
			broker := &sequenceBroker{leases: []RequestAuthHeaders{geminiRequestAuth("cancel-key")}}
			upstream := &cancellationRoundTripper{started: make(chan struct{}), canceled: make(chan struct{})}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, result := runGateway(t, gateway)
			defer stopGateway(t, cancel, result)
			_ = awaitManagedHealthIdentity(t, cfg)
			ctx, cancelRequest := context.WithCancel(context.Background())
			defer cancelRequest()
			request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://%s:%d%s", cfg.Host, cfg.Port, testCase.path), strings.NewReader(testCase.request))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer "+cfg.DownstreamBearer)
			request.Header.Set("Content-Type", "application/json")
			settled := make(chan error, 1)
			go func() {
				response, err := http.DefaultClient.Do(request)
				if response != nil {
					_ = response.Body.Close()
				}
				settled <- err
			}()
			select {
			case <-upstream.started:
			case <-time.After(5 * time.Second):
				t.Fatal("Gemini upstream did not start")
			}
			cancelRequest()
			select {
			case <-upstream.canceled:
			case <-time.After(5 * time.Second):
				t.Fatal("Gemini upstream was not canceled")
			}
			select {
			case err := <-settled:
				if err == nil {
					t.Fatal("canceled Gemini request succeeded")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("Gemini client did not settle")
			}
			if purposes := broker.purposes(); len(purposes) != 1 || purposes[0] != testPurpose("gemini-upstream") {
				t.Fatalf("cancellation borrowed another credential: %#v", purposes)
			}
		})
	}
}

func assertGeminiWire(t *testing.T, request *http.Request, key string) {
	t.Helper()
	if request.URL.Scheme != "https" || request.URL.Host != "generativelanguage.googleapis.com" || !strings.HasPrefix(request.URL.Path, "/v1beta/models/gemini-2.5-flash:") || request.Header.Get("x-goog-api-key") != key || request.Header.Get("Authorization") != "" || request.URL.Query().Has("key") {
		t.Fatalf("Gemini did not use selected raw key at declared origin: %s headers=%v", request.URL, request.Header)
	}
}

func geminiTranslatedToolCallID(stream string) string {
	for _, line := range strings.Split(stream, "\n") {
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var event struct {
			ContentBlock struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			} `json:"content_block"`
			Item struct {
				CallID string `json:"call_id"`
			} `json:"item"`
			Choices []struct {
				Delta struct {
					ToolCalls []struct {
						ID string `json:"id"`
					} `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &event) != nil {
			continue
		}
		if event.ContentBlock.Type == "tool_use" && event.ContentBlock.ID != "" {
			return event.ContentBlock.ID
		}
		if event.Item.CallID != "" {
			return event.Item.CallID
		}
		for _, choice := range event.Choices {
			for _, call := range choice.Delta.ToolCalls {
				if call.ID != "" {
					return call.ID
				}
			}
		}
	}
	return ""
}

type geminiFixtureRoundTripper struct {
	captureRoundTripper
	statuses         []int
	responseOverride string
}

func (fixture *geminiFixtureRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	cloned := request.Clone(request.Context())
	cloned.Header = request.Header.Clone()
	cloned.Body = io.NopCloser(bytes.NewReader(body))
	fixture.mu.Lock()
	index := len(fixture.seen)
	fixture.seen = append(fixture.seen, cloned)
	fixture.mu.Unlock()
	status, contentType := http.StatusOK, "application/json"
	response := `{"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"fixture-final"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"totalTokenCount":10},"modelVersion":"gemini-2.5-flash","responseId":"gemini-fixture"}`
	if strings.HasSuffix(request.URL.Path, ":streamGenerateContent") {
		contentType = "text/event-stream"
		response = geminiToolStream()
	}
	if strings.HasSuffix(request.URL.Path, ":countTokens") {
		response = `{"totalTokens":17}`
	}
	if fixture.responseOverride != "" {
		response = fixture.responseOverride
	}
	if index < len(fixture.statuses) {
		status = fixture.statuses[index]
		response = fmt.Sprintf(`{"error":{"code":%d,"message":"fixture failure","status":"FIXTURE_ERROR"}}`, status)
	}
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {contentType}}, Body: io.NopCloser(strings.NewReader(response)), Request: request}, nil
}

func geminiToolStream() string {
	return "data: " + `{"candidates":[{"index":0,"content":{"role":"model","parts":[{"thought":true,"text":"fixture-thought"}]}}],"modelVersion":"gemini-2.5-flash","responseId":"gemini-fixture"}` + "\n\n" +
		"data: " + `{"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"fixture-text"}]}}]}` + "\n\n" +
		"data: " + `{"candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"id":"call_1","name":"fixture_tool","partialArgs":[{"jsonPath":"$.value","stringValue":"o","willContinue":true}],"willContinue":true}}]}}]}` + "\n\n" +
		"data: " + `{"candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"partialArgs":[{"jsonPath":"$.value","stringValue":"k","willContinue":false}]}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"thoughtsTokenCount":2,"totalTokenCount":12}}` + "\n\n"
}
