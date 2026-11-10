package managedruntime

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	cliproxy "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
)

// Only the daemon broker and vendor HTTP boundary are fake. Admission, source
// registration, Manager.Execute/ExecuteStream and native request shaping run.
func TestManagedHeaderOnlyFamiliesUseAdmittedFactsAndLateCredentials(t *testing.T) {
	for _, family := range []struct {
		provider, purpose, model string
		factsA, factsB           map[string]any
		hostA, hostB, path       string
		staticOnly, anthropic    bool
	}{
		{"kimi", "kimi-upstream", "kimi-for-coding", map[string]any{"domain": "kimi.com", "deviceId": "device-a"}, map[string]any{"domain": "kimi.ai", "deviceId": "device-b"}, "api.kimi.com", "api.kimi.ai", "/coding/v1/chat/completions", false, false},
		{"kimi", "kimi-upstream", "kimi-for-coding", map[string]any{"domain": "kimi.com", "deviceId": "device-a"}, map[string]any{"domain": "kimi.ai", "deviceId": "device-b"}, "api.kimi.com", "api.kimi.ai", "/coding/v1/messages", false, true},
		{"xai", "xai-upstream", "grok-4", map[string]any{"usingApi": true, "base": "https://api.x.ai/v1"}, map[string]any{"usingApi": false, "base": "https://cli-chat-proxy.grok.com/custom/v1"}, "api.x.ai", "cli-chat-proxy.grok.com", "/v1/responses", false, false},
		{"antigravity", "antigravity-upstream", "gemini-2.5-flash", map[string]any{"projectId": "project-a"}, map[string]any{"projectId": "project-b"}, "", "", ":generateContent", false, false},
		{"antigravity", "antigravity-upstream", "gemini-3-flash", map[string]any{"projectId": "project-a"}, map[string]any{"projectId": "project-b"}, "", "", ":generateContent", true, false},
	} {
		name := family.provider
		if family.staticOnly {
			name += "/static-fallback"
		}
		if family.anthropic {
			name += "/anthropic"
		}
		t.Run(name, func(t *testing.T) {
			for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "MANAGEMENT_PASSWORD"} {
				t.Setenv(key, "")
			}
			var mu sync.Mutex
			var requests []*http.Request
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				payload, _ := io.ReadAll(r.Body)
				r.Body = io.NopCloser(bytes.NewReader(payload))
				mu.Lock()
				requests = append(requests, r)
				mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				if strings.Contains(r.URL.Path, "fetchAvailableModels") {
					_, _ = io.WriteString(w, `{"models":{}}`)
					return
				}
				w.WriteHeader(http.StatusTeapot)
				_, _ = io.WriteString(w, `{"error":{"message":"fixture delivery"}}`)
			}))
			defer server.Close()
			boundary := &headerOnlyHTTPBoundary{server: server.URL, base: server.Client().Transport}
			previous := http.DefaultTransport
			http.DefaultTransport = boundary
			defer func() { http.DefaultTransport = previous }()
			root := t.TempDir()
			entry := testAuthEntry(family.provider, Provider(family.provider), family.purpose)
			if descriptor, ok := managedFamilyForProvider(entry.Provider); ok {
				entry.AllowedHTTPSOrigins = descriptor.Origins
			}
			cfg := Config{Host: "127.0.0.1", Port: reserveLoopbackPort(t), RuntimeDir: root, DownstreamBearer: "physical", ConsumerAccessPath: filepath.Join(root, "consumers.json"), AuthEntries: []AuthEntry{entry}, Protocols: []ProviderProtocol{ProtocolOpenAIChat, ProtocolAnthropic}, ModelListEnabled: true}
			broker := &sequenceBroker{leases: []RequestAuthHeaders{validLease("borrowed-a", nil), validLease("borrowed-b", nil)}}
			if family.provider == "kimi" {
				broker.leases[0].Headers["X-Msh-Device-Id"] = "device-a"
				broker.leases[1].Headers["X-Msh-Device-Id"] = "device-b"
			}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, boundary)
			if err != nil {
				t.Fatal(err)
			}
			cancel, result := runGateway(t, gateway)
			defer stopGateway(t, cancel, result)
			// Empty Antigravity native discovery is allowed. Its admitted source
			// models, rather than startup health, establish availability below.
			deadline := time.Now().Add(5 * time.Second)
			for {
				response, err := http.Get(fmt.Sprintf("http://%s:%d/healthz", cfg.Host, cfg.Port))
				if err == nil {
					response.Body.Close()
					break
				}
				if time.Now().After(deadline) {
					t.Fatal(err)
				}
				time.Sleep(10 * time.Millisecond)
			}
			gateway.service.WaitAntigravityProbes()
			awaitManagedHealthIdentity(t, cfg)
			consumerCfg := cfg
			consumerCfg.DownstreamBearer = testCapability(114)
			for revision, facts := range []map[string]any{family.factsA, family.factsB} {
				access := map[string]any{"token": consumerCfg.DownstreamBearer, "capabilityPath": filepath.Join(root, "capability.json"), "purposes": []QualifiedPurpose{entry.Purpose}, "authFacts": []map[string]any{{"purpose": entry.Purpose, "facts": facts}}}
				if !family.staticOnly {
					access["modelCatalogs"] = []map[string]any{{"purpose": entry.Purpose, "sourceRevision": "models", "models": []map[string]any{{"id": family.model}}}}
				}
				writeConsumerAccess(t, cfg.ConsumerAccessPath, access)
				path := "/v1/chat/completions"
				if family.anthropic {
					path = "/v1/messages"
				}
				response := postJSON(t, consumerCfg, path, fmt.Sprintf(`{"model":%q,"max_tokens":64,"messages":[{"role":"user","content":"hello"}],"stream":%t}`, family.model, revision == 1))
				body := readResponse(t, response)
				response.Body.Close()
				if response.StatusCode != http.StatusTeapot || !strings.Contains(body, "fixture delivery") {
					t.Fatalf("revision %d: status=%d body=%s", revision, response.StatusCode, body)
				}
				mu.Lock()
				snapshot := append([]*http.Request(nil), requests...)
				mu.Unlock()
				var sent *http.Request
				for _, candidate := range snapshot {
					if candidate.Header.Get("Authorization") == []string{"Bearer borrowed-a", "Bearer borrowed-b"}[revision] {
						sent = candidate
					}
				}
				if sent == nil {
					t.Fatal("native executor did not send borrowed credential")
				}
				payload, _ := io.ReadAll(sent.Body)
				if bytes.Contains(payload, []byte("borrowed-")) {
					t.Fatal("borrowed credential reached inference body")
				}
				if family.provider == "kimi" && (sent.Header.Get("X-Msh-Device-Id") != facts["deviceId"] || sent.Header.Get("X-Fixture-Host") != []string{family.hostA, family.hostB}[revision] || sent.URL.Path != family.path) {
					t.Fatalf("Kimi facts not applied: host=%s path=%s device=%s", sent.Header.Get("X-Fixture-Host"), sent.URL.Path, sent.Header.Get("X-Msh-Device-Id"))
				}
				if family.provider == "xai" {
					wantPath := family.path
					if revision == 1 {
						wantPath = "/custom/v1/responses"
					}
					if sent.Header.Get("X-Fixture-Host") != []string{family.hostA, family.hostB}[revision] || sent.URL.Path != wantPath {
						t.Fatalf("xAI facts not applied: host=%s path=%s", sent.Header.Get("X-Fixture-Host"), sent.URL.Path)
					}
				}
				if family.provider == "antigravity" && !bytes.Contains(payload, []byte(facts["projectId"].(string))) {
					t.Fatalf("registered project missing from body: %s", payload)
				}
				auth, ok := gateway.coreManager.GetByID(sourceModelClientID(consumerCfg.DownstreamBearer, entry.ID))
				if !ok || auth.Metadata["access_token"] != "happier-registration-sentinel" || auth.Metadata["refresh_token"] != nil || auth.Runtime.(neverRefreshRuntime).ShouldRefresh(time.Now(), auth) {
					t.Fatal("registration acquired persistent credentials or refresh state")
				}
				if family.provider == "kimi" && (auth.Metadata["device_id"] != facts["deviceId"] || auth.Metadata["domain"] != facts["domain"] || auth.Attributes["header:X-Msh-Device-Id"] != facts["deviceId"]) {
					t.Fatal("Kimi registration lost native/Anthropic device or regional facts")
				}
				if family.provider == "xai" && (auth.Metadata["using_api"] != facts["usingApi"] || auth.Attributes["base_url"] != facts["base"]) {
					t.Fatal("xAI registration lost mode or base URL")
				}
			}
			if len(broker.purposes()) != 2 {
				t.Fatalf("two upstream attempts borrowed %d times", len(broker.purposes()))
			}
			if family.staticOnly {
				found := false
				for _, model := range getStrictOpenAIModelCatalog(t, consumerCfg) {
					if string(model["id"]) == fmt.Sprintf("%q", family.model) {
						found = true
					}
				}
				if !found || len(broker.purposes()) != 2 {
					t.Fatal("static model list disappeared or presentation borrowed credentials")
				}
			}
			gateway.service.WaitAntigravityProbes()
			if !cliproxy.GlobalModelRegistry().ClientSupportsModel(sourceModelClientID(consumerCfg.DownstreamBearer, entry.ID), family.model) {
				t.Fatal("empty native probe withdrew admitted source model")
			}
			writeConsumerAccess(t, cfg.ConsumerAccessPath, map[string]any{"token": consumerCfg.DownstreamBearer, "capabilityPath": filepath.Join(root, "capability.json"), "purposes": []QualifiedPurpose{entry.Purpose}, "authFacts": []map[string]any{{"purpose": entry.Purpose, "facts": map[string]any{}}}})
			response := postJSON(t, consumerCfg, "/v1/chat/completions", fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"missing facts"}]}`, family.model))
			response.Body.Close()
			if response.StatusCode != http.StatusServiceUnavailable || len(broker.purposes()) != 2 {
				t.Fatal("missing registered facts reached native execution or borrowed credentials")
			}
			mu.Lock()
			defer mu.Unlock()
			for _, request := range requests {
				lower := strings.ToLower(request.URL.Path)
				if strings.Contains(lower, "token") || strings.Contains(lower, "loadcodeassist") || strings.Contains(lower, "onboard") {
					t.Fatalf("native credential acquisition: %s", request.URL.Path)
				}
			}
		})
	}
}

type headerOnlyHTTPBoundary struct {
	server string
	base   http.RoundTripper
}

func (b *headerOnlyHTTPBoundary) RoundTrip(r *http.Request) (*http.Response, error) {
	// Only external HTTP is redirected; local serving traffic uses the real socket.
	if r.URL.Scheme == "http" {
		return b.base.RoundTrip(r)
	}
	q := r.Clone(r.Context())
	u := *r.URL
	q.URL = &u
	q.URL.Scheme = "http"
	q.URL.Host = strings.TrimPrefix(b.server, "http://")
	q.Host = ""
	q.Header = r.Header.Clone()
	q.Header.Set("X-Fixture-Host", r.URL.Host)
	return b.base.RoundTrip(q)
}
