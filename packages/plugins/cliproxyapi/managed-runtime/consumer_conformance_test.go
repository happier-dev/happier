package managedruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func writeConsumerAccess(t *testing.T, path string, consumers ...map[string]any) {
	t.Helper()
	if consumers == nil {
		consumers = []map[string]any{}
	}
	data, err := json.Marshal(map[string]any{"v": 1, "consumers": consumers})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestPinnedSDKSharedConsumersUseExactSubjectAndRejectUnboundOrRevokedAuthority(t *testing.T) {
	runtimeDir := t.TempDir()
	accessPath := filepath.Join(runtimeDir, "consumers.json")
	var mu sync.Mutex
	var lookups []string
	capabilities := map[string]string{testCapability(51): "member-one", testCapability(52): "member-two"}
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capability := r.Header.Get(ConnectedAccountCapabilityHeader)
		member, ok := capabilities[capability]
		if !ok || r.URL.Path != ConnectedAccountRequestAuthLookupPath {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var input struct {
			Purpose QualifiedPurpose `json:"purpose"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.Purpose != testPurpose("openai-upstream") {
			t.Errorf("wrong consumer purpose: %#v, %v", input, err)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		mu.Lock()
		lookups = append(lookups, member)
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "value": validLease(member, nil)})
	}))
	defer daemon.Close()
	daemonURL, _ := url.Parse(daemon.URL)
	daemonPort, _ := strconv.Atoi(daemonURL.Port())
	onePath, twoPath := filepath.Join(runtimeDir, "one.json"), filepath.Join(runtimeDir, "two.json")
	writeCapabilityV2(t, onePath, testCapability(51), daemonPort)
	writeCapabilityV2(t, twoPath, testCapability(52), daemonPort)
	one := map[string]any{"token": testCapability(61), "capabilityPath": onePath, "purposes": []QualifiedPurpose{testPurpose("openai-upstream")}}
	two := map[string]any{"token": testCapability(62), "capabilityPath": twoPath, "purposes": []QualifiedPurpose{testPurpose("openai-upstream")}}
	writeConsumerAccess(t, accessPath, one, two)
	cfg := Config{
		Host: "127.0.0.1", Port: reserveLoopbackPort(t), RuntimeDir: runtimeDir,
		DownstreamBearer: "physical-health-secret", ConsumerAccessPath: accessPath,
		AuthEntries: []AuthEntry{testAuthEntry("codex", ProviderCodex, "openai-upstream"), testAuthEntry("claude", ProviderClaude, "anthropic-upstream")},
		Protocols:   []ProviderProtocol{ProtocolOpenAIChat, ProtocolOpenAIResponses, ProtocolAnthropic}, ModelListEnabled: true,
	}
	// A legacy default is intentionally supplied: a shared request must never
	// accidentally borrow the first consumer's capability.
	broker, err := NewHTTPBroker(HTTPBrokerConfig{CapabilityPath: onePath, ConsumerAccessPath: accessPath})
	if err != nil {
		t.Fatal(err)
	}
	upstream := &protocolFixtureRoundTripper{}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatal(err)
	}
	cancel, result := runGateway(t, gateway)
	defer stopGateway(t, cancel, result)
	_ = awaitManagedHealthIdentity(t, cfg)
	consumerConfig := cfg
	for index, consumer := range []map[string]any{one, two} {
		consumerConfig.DownstreamBearer = consumer["token"].(string)
		payload := `{"model":"gpt-5.5","input":"hello"}`
		if index == 0 {
			payload = `{"model":"gpt-5.5","input":"hello","stream":true,"tools":[{"type":"function","name":"fixture_tool","parameters":{"type":"object","properties":{}}}]}`
		}
		response := postJSON(t, consumerConfig, "/v1/responses", payload)
		body := readResponse(t, response)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("consumer request = %d: %s", response.StatusCode, body)
		}
		if index == 0 && !strings.Contains(body, `"type":"response.completed"`) {
			t.Fatalf("shared consumer stream lost terminal event: %s", body)
		}
		models := getStrictOpenAIModelCatalog(t, consumerConfig)
		for _, model := range models {
			var id string
			if err := json.Unmarshal(model["id"], &id); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(id, "claude") {
				t.Fatalf("unbound vendor in consumer catalog: %#v", model)
			}
		}
	}
	requests := upstream.requests()
	if len(requests) != 2 || requests[0].Header.Get("Authorization") != "Bearer member-one" || requests[1].Header.Get("Authorization") != "Bearer member-two" {
		t.Fatalf("consumer credentials crossed: %#v", requests)
	}
	for _, token := range []string{one["token"].(string), "wrong", cfg.DownstreamBearer} {
		consumerConfig.DownstreamBearer = token
		response := postJSON(t, consumerConfig, "/v1/responses", `{"model":"claude-sonnet-4-6","input":"hello"}`)
		_ = response.Body.Close()
		if response.StatusCode < 400 {
			t.Fatalf("unbound/wrong bearer admitted: %d", response.StatusCode)
		}
	}
	for _, consumer := range []map[string]any{one, two} {
		consumerConfig.DownstreamBearer = consumer["token"].(string)
		response := postJSON(t, consumerConfig, "/v1/messages", `{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"unbound"}]}`)
		_ = response.Body.Close()
		if response.StatusCode < 400 {
			t.Fatalf("unbound Anthropic route admitted: %d", response.StatusCode)
		}
	}
	for _, path := range []string{"/v1/responses", "/v1/models"} {
		method := http.MethodPost
		if path == "/v1/models" {
			method = http.MethodGet
		}
		request, _ := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", cfg.Port, path), strings.NewReader(`{"model":"gpt-5.5","input":"physical key"}`))
		request.Header.Set("Authorization", "Bearer "+cfg.DownstreamBearer)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("management key admitted %s: %d", path, response.StatusCode)
		}
	}
	foreign := testPurpose("openai-upstream")
	foreign.Consumer.PluginID = "foreign.provider.gateway"
	writeConsumerAccess(t, accessPath, map[string]any{"token": one["token"], "capabilityPath": onePath, "purposes": []QualifiedPurpose{foreign}})
	consumerConfig.DownstreamBearer = one["token"].(string)
	response := postJSON(t, consumerConfig, "/v1/responses", `{"model":"gpt-5.5","input":"wrong qualified consumer"}`)
	_ = response.Body.Close()
	if response.StatusCode < 400 {
		t.Fatalf("unqualified purpose name granted access: %d", response.StatusCode)
	}
	for _, consumers := range [][]map[string]any{{one, one}, {map[string]any{"token": one["token"], "capabilityPath": onePath, "purposes": []QualifiedPurpose{testPurpose("openai-upstream")}, "sessionId": "unadmitted"}}} {
		writeConsumerAccess(t, accessPath, consumers...)
		response := postJSON(t, consumerConfig, "/v1/responses", `{"model":"gpt-5.5","input":"invalid access document"}`)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("invalid access document admitted: %d", response.StatusCode)
		}
	}
	writeConsumerAccess(t, accessPath, two)
	consumerConfig.DownstreamBearer = one["token"].(string)
	response = postJSON(t, consumerConfig, "/v1/responses", `{"model":"gpt-5.5","input":"revoked"}`)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked token = %d", response.StatusCode)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(lookups) != 2 || lookups[0] != "member-one" || lookups[1] != "member-two" || len(upstream.requests()) != 2 {
		t.Fatalf("rejected authority caused credential/upstream effects: %#v", lookups)
	}
}

func TestPinnedSDKSharedConsumerSettlementCancelsOnlyReleasedConsumerAndJoinsInflight(t *testing.T) {
	accessPath := filepath.Join(t.TempDir(), "consumers.json")
	purpose := testPurpose("openai-upstream")
	writeConsumerAccess(t, accessPath,
		map[string]any{"token": testCapability(71), "capabilityPath": filepath.Join(t.TempDir(), "one.json"), "purposes": []QualifiedPurpose{purpose}},
		map[string]any{"token": testCapability(72), "capabilityPath": filepath.Join(t.TempDir(), "two.json"), "purposes": []QualifiedPurpose{purpose}},
	)
	cfg := Config{Host: "127.0.0.1", Port: reserveLoopbackPort(t), RuntimeDir: t.TempDir(), DownstreamBearer: "health-secret", ConsumerAccessPath: accessPath,
		AuthEntries: []AuthEntry{testAuthEntry("codex", ProviderCodex, "openai-upstream")}, Protocols: []ProviderProtocol{ProtocolOpenAIResponses}}
	started, canceled := make(chan struct{}), make(chan struct{})
	finish := make(chan struct{})
	var finishOnce sync.Once
	var attempt int
	var mu sync.Mutex
	fixture := &protocolFixtureRoundTripper{}
	upstream := roundTripperFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		attempt++
		current := attempt
		mu.Unlock()
		if current == 1 {
			close(started)
			<-r.Context().Done()
			close(canceled)
			<-finish
			return nil, r.Context().Err()
		}
		return fixture.RoundTrip(r)
	})
	broker := &sequenceBroker{leases: []OAuthBearerLease{validLease("first", nil), validLease("second", nil), validLease("second-current", nil)}}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatal(err)
	}
	cancelGateway, result := runGateway(t, gateway)
	defer stopGateway(t, cancelGateway, result)
	defer finishOnce.Do(func() { close(finish) })
	_ = awaitManagedHealthIdentity(t, cfg)
	ctx, cancelRequest := context.WithCancel(context.Background())
	defer cancelRequest()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/responses", cfg.Port), strings.NewReader(`{"model":"gpt-5.5","input":"first"}`))
	request.Header.Set("Authorization", "Bearer "+testCapability(71))
	request.Header.Set("Content-Type", "application/json")
	settled := make(chan error, 1)
	go func() {
		response, err := http.DefaultClient.Do(request)
		if response != nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
		settled <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("first consumer did not enter upstream")
	}
	other := cfg
	other.DownstreamBearer = testCapability(72)
	response := postJSON(t, other, "/v1/responses", `{"model":"gpt-5.5","input":"second"}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("second consumer failed: %d %s", response.StatusCode, readResponse(t, response))
	}
	_ = response.Body.Close()
	retainedSettlement := postJSON(t, cfg, "/_happier/consumer-access/settle", fmt.Sprintf(`{"token":%q}`, testCapability(71)))
	if retainedSettlement.StatusCode != http.StatusConflict {
		t.Fatalf("retained consumer was canceled: %d", retainedSettlement.StatusCode)
	}
	_ = retainedSettlement.Body.Close()
	unauthorizedSettlement := postJSON(t, other, "/_happier/consumer-access/settle", fmt.Sprintf(`{"token":%q}`, testCapability(71)))
	if unauthorizedSettlement.StatusCode != http.StatusUnauthorized {
		t.Fatalf("consumer key authorized settlement: %d", unauthorizedSettlement.StatusCode)
	}
	_ = unauthorizedSettlement.Body.Close()
	writeConsumerAccess(t, accessPath,
		map[string]any{"token": testCapability(72), "capabilityPath": filepath.Join(t.TempDir(), "two.json"), "purposes": []QualifiedPurpose{purpose}},
	)
	settlementResult := make(chan int, 1)
	go func() {
		request, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/_happier/consumer-access/settle", cfg.Port), strings.NewReader(fmt.Sprintf(`{"token":%q}`, testCapability(71))))
		request.Header.Set("Authorization", "Bearer "+cfg.DownstreamBearer)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			settlementResult <- 0
			return
		}
		_ = response.Body.Close()
		settlementResult <- response.StatusCode
	}()
	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("first cancellation did not reach upstream")
	}
	select {
	case status := <-settlementResult:
		t.Fatalf("consumer reported settlement before its request finished: %d", status)
	case <-time.After(50 * time.Millisecond):
	}
	response = postJSON(t, other, "/v1/responses", `{"model":"gpt-5.5","input":"still active while first settles"}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("pending settlement canceled another consumer: %d", response.StatusCode)
	}
	_ = response.Body.Close()
	finishOnce.Do(func() { close(finish) })
	select {
	case status := <-settlementResult:
		if status != http.StatusOK {
			t.Fatalf("released consumer did not settle: %d", status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("consumer settlement did not finish")
	}
	cancelRequest()
	select {
	case <-settled:
	case <-time.After(5 * time.Second):
		t.Fatal("first consumer did not settle")
	}
}

func TestPinnedSDKSharedConsumerRevocationDuringBorrowPreventsUpstreamEffect(t *testing.T) {
	root := t.TempDir()
	accessPath, capabilityPath := filepath.Join(root, "consumers.json"), filepath.Join(root, "capability.json")
	started, release := make(chan struct{}), make(chan struct{})
	ctx, cancelRequest := context.WithCancel(context.Background())
	defer cancelRequest()
	allowBorrow := make(chan struct{})
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-allowBorrow:
		case <-release:
		case <-r.Context().Done():
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "value": validLease("revoked-before-use", nil)})
	}))
	defer daemon.Close()
	defer close(release)
	daemonURL, _ := url.Parse(daemon.URL)
	port, _ := strconv.Atoi(daemonURL.Port())
	writeCapabilityV2(t, capabilityPath, testCapability(81), port)
	writeConsumerAccess(t, accessPath, map[string]any{"token": testCapability(82), "capabilityPath": capabilityPath, "purposes": []QualifiedPurpose{testPurpose("openai-upstream")}})
	cfg := Config{Host: "127.0.0.1", Port: reserveLoopbackPort(t), RuntimeDir: root, DownstreamBearer: "health-secret", ConsumerAccessPath: accessPath,
		AuthEntries: []AuthEntry{testAuthEntry("codex", ProviderCodex, "openai-upstream")}, Protocols: []ProviderProtocol{ProtocolOpenAIResponses}}
	broker, err := NewHTTPBroker(HTTPBrokerConfig{ConsumerAccessPath: accessPath})
	if err != nil {
		t.Fatal(err)
	}
	upstream := &protocolFixtureRoundTripper{}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatal(err)
	}
	cancelGateway, result := runGateway(t, gateway)
	defer stopGateway(t, cancelGateway, result)
	_ = awaitManagedHealthIdentity(t, cfg)
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/responses", cfg.Port), strings.NewReader(`{"model":"gpt-5.5","input":"pending borrow"}`))
	request.Header.Set("Authorization", "Bearer "+testCapability(82))
	request.Header.Set("Content-Type", "application/json")
	settled := make(chan *http.Response, 1)
	go func() { response, _ := http.DefaultClient.Do(request); settled <- response }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("consumer borrow did not start")
	}
	writeConsumerAccess(t, accessPath)
	close(allowBorrow)
	select {
	case response := <-settled:
		if response == nil {
			t.Fatal("request did not return typed refusal")
		}
		_ = response.Body.Close()
		if response.StatusCode < 400 || len(upstream.requests()) != 0 {
			t.Fatalf("revocation during borrow admitted upstream: status=%d effects=%d", response.StatusCode, len(upstream.requests()))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("revoked borrow did not settle")
	}
}
