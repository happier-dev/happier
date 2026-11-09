package managedruntime

import (
	"context"
	"encoding/base64"
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

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// The consumer file disappears immediately after admission. Both attempts must
// therefore use the one admitted document, while each capability acquisition
// still observes the daemon's current private capability file.
func TestConsumerAdmissionSuppliesSelectorBrokerAndTransportWithoutReparsing(t *testing.T) {
	root := t.TempDir()
	accessPath, capabilityPath := filepath.Join(root, "consumers.json"), filepath.Join(root, "selected-capability.json")
	entry := testAuthEntry("codex", ProviderCodex, "openai-upstream")
	var acquired []string
	var acquiredMu sync.Mutex
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Purpose QualifiedPurpose `json:"purpose"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.Purpose != entry.Purpose {
			t.Error("broker lost the admitted qualified purpose")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		acquiredMu.Lock()
		acquired = append(acquired, r.Header.Get(ConnectedAccountCapabilityHeader))
		acquiredMu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "value": validLease("selected-source", nil)})
	}))
	defer daemon.Close()
	daemonURL, _ := url.Parse(daemon.URL)
	port, _ := strconv.Atoi(daemonURL.Port())
	writeCapabilityV2(t, capabilityPath, testCapability(91), port)
	consumers := make([]map[string]any, 0, 1001)
	for i := range 1000 {
		consumers = append(consumers, map[string]any{"token": base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("unrelated-consumer-%013d", i))), "capabilityPath": filepath.Join(root, "unused.json"), "purposes": []QualifiedPurpose{entry.Purpose}})
	}
	token := testCapability(90)
	consumers = append(consumers, map[string]any{"token": token, "capabilityPath": capabilityPath, "purposes": []QualifiedPurpose{entry.Purpose},
		"modelCatalogs": []map[string]any{{"purpose": entry.Purpose, "sourceRevision": "selected-revision", "models": []map[string]any{{"id": "selected-model"}}}}})
	writeConsumerAccess(t, accessPath, consumers...)
	selector := &consumerAdmissionSelector{entries: map[string]AuthEntry{entry.ID: entry}, delegate: &coreauth.RoundRobinSelector{}}
	manager := coreauth.NewManager(nil, selector, nil)
	owner := newConsumerAccessOwner(Config{ConsumerAccessPath: accessPath, DownstreamBearer: "physical-health", AuthEntries: []AuthEntry{entry}}, manager)
	defer owner.models.close()
	broker, err := NewHTTPBroker(HTTPBrokerConfig{ConsumerAccessPath: accessPath})
	if err != nil {
		t.Fatal(err)
	}
	upstream := &protocolFixtureRoundTripper{}
	provider, err := newLeaseRoundTripperProvider([]AuthEntry{entry}, broker, upstream)
	if err != nil {
		t.Fatal(err)
	}
	provider.consumerAccessRequired = true
	router := gin.New()
	router.Use(owner.middleware())
	router.POST("/v1/responses", func(c *gin.Context) {
		if err := os.Remove(accessPath); err != nil {
			t.Error(err)
			c.Status(http.StatusInternalServerError)
			return
		}
		for attempt := range 2 {
			auth, err := selector.Pick(c.Request.Context(), string(entry.Provider), "selected-model", cliproxyexecutor.Options{}, manager.List())
			if err != nil || auth == nil || auth.ID != sourceModelClientID(token, entry.ID) {
				t.Errorf("selector lost admitted model-source identity: %v", err)
				c.Status(http.StatusInternalServerError)
				return
			}
			if attempt == 1 {
				writeCapabilityV2(t, capabilityPath, testCapability(92), port)
			}
			request, _ := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, entry.AllowedHTTPSOrigins[0]+"/backend-api/codex/responses", strings.NewReader(`{"model":"selected-model"}`))
			response, err := provider.RoundTripperFor(auth).RoundTrip(request)
			if err != nil {
				t.Errorf("admitted attempt failed: %v", err)
				c.Status(http.StatusInternalServerError)
				return
			}
			_ = response.Body.Close()
		}
		c.Status(http.StatusOK)
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	acquiredMu.Lock()
	defer acquiredMu.Unlock()
	if response.Code != http.StatusOK || len(acquired) != 2 || acquired[0] != testCapability(91) || acquired[1] != testCapability(92) || len(upstream.requests()) != 2 {
		t.Fatalf("admission/capability cost contract failed: status=%d lookups=%d sends=%d", response.Code, len(acquired), len(upstream.requests()))
	}
	for _, sent := range upstream.requests() {
		if sent.Header.Get("Authorization") != "Bearer selected-source" {
			t.Fatal("admitted source credential was not preserved")
		}
	}
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatal("new admission did not read the withdrawn document")
	}
}

func TestConsumerSettlementClosesOpenEndedWebSocketAccess(t *testing.T) {
	root := t.TempDir()
	accessPath := filepath.Join(root, "consumers.json")
	token := testCapability(93)
	writeConsumerAccess(t, accessPath, map[string]any{"token": token, "capabilityPath": filepath.Join(root, "capability.json"), "purposes": []QualifiedPurpose{testPurpose("openai-upstream")}})
	owner := newConsumerAccessOwner(Config{ConsumerAccessPath: accessPath, DownstreamBearer: "physical-health"}, coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, nil))
	router := gin.New()
	router.Use(owner.middleware())
	router.POST(ConsumerAccessSettlementPath, func(*gin.Context) {})
	stop := make(chan struct{})
	router.GET("/v1/responses", func(c *gin.Context) {
		connection, err := (&websocket.Upgrader{}).Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close()
		select {
		case <-c.Request.Context().Done():
		case <-stop:
		}
	})
	server := httptest.NewServer(router)
	defer server.Close()
	defer close(stop)
	connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/v1/responses", http.Header{"Authorization": []string{"Bearer " + token}})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	writeConsumerAccess(t, accessPath)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+ConsumerAccessSettlementPath, strings.NewReader(fmt.Sprintf(`{"token":%q}`, token)))
	request.Header.Set("Authorization", "Bearer physical-health")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("open-ended settlement failed: %d", response.StatusCode)
	}
	if _, _, err := connection.ReadMessage(); err == nil {
		t.Fatal("settlement retained open-ended access")
	}
}

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
	all := map[string]any{"token": testCapability(63), "capabilityPath": onePath, "purposes": []QualifiedPurpose{testPurpose("openai-upstream"), testPurpose("anthropic-upstream")}}
	writeConsumerAccess(t, accessPath, one, two, all)
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
		payload := `{"model":"gpt-6.1-sol","input":"hello"}`
		if index == 0 {
			payload = `{"model":"gpt-6.1-sol","input":"hello","stream":true,"tools":[{"type":"function","name":"fixture_tool","parameters":{"type":"object","properties":{}}}]}`
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
			var purposes []QualifiedPurpose
			if err := json.Unmarshal(model["happier_connected_account_purposes"], &purposes); err != nil || len(purposes) != 1 || purposes[0] != testPurpose("openai-upstream") {
				t.Fatalf("consumer model omitted its admitted vendor slot: %#v, %v", model, err)
			}
			var id string
			if err := json.Unmarshal(model["id"], &id); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(id, "claude") {
				t.Fatalf("unbound vendor in consumer catalog: %#v", model)
			}
		}
	}
	consumerConfig.DownstreamBearer = all["token"].(string)
	mixedModels := getStrictOpenAIModelCatalog(t, consumerConfig)
	for _, expected := range []struct{ id, purpose string }{{"gpt-6.1-sol", "openai-upstream"}, {"claude-sonnet-4-6", "anthropic-upstream"}} {
		found := false
		for _, model := range mixedModels {
			var id string
			_ = json.Unmarshal(model["id"], &id)
			if id != expected.id {
				continue
			}
			found = true
			var purposes []QualifiedPurpose
			if err := json.Unmarshal(model["happier_connected_account_purposes"], &purposes); err != nil || len(purposes) != 1 || purposes[0] != testPurpose(expected.purpose) {
				t.Fatalf("mixed consumer model has wrong vendor slot: %#v, %v", model, err)
			}
		}
		if !found {
			t.Fatalf("mixed consumer catalog omitted %s", expected.id)
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
		request, _ := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", cfg.Port, path), strings.NewReader(`{"model":"gpt-6.1-sol","input":"physical key"}`))
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
	response := postJSON(t, consumerConfig, "/v1/responses", `{"model":"gpt-6.1-sol","input":"wrong qualified consumer"}`)
	_ = response.Body.Close()
	if response.StatusCode < 400 {
		t.Fatalf("unqualified purpose name granted access: %d", response.StatusCode)
	}
	for _, consumers := range [][]map[string]any{{one, one}, {map[string]any{"token": one["token"], "capabilityPath": onePath, "purposes": []QualifiedPurpose{testPurpose("openai-upstream")}, "sessionId": "unadmitted"}}} {
		writeConsumerAccess(t, accessPath, consumers...)
		response := postJSON(t, consumerConfig, "/v1/responses", `{"model":"gpt-6.1-sol","input":"invalid access document"}`)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("invalid access document admitted: %d", response.StatusCode)
		}
	}
	writeConsumerAccess(t, accessPath, two)
	consumerConfig.DownstreamBearer = one["token"].(string)
	response = postJSON(t, consumerConfig, "/v1/responses", `{"model":"gpt-6.1-sol","input":"revoked"}`)
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

func TestPinnedSDKSharedConsumerSettlementJoinsFiniteSSEAndRetainsSourceModels(t *testing.T) {
	accessPath := filepath.Join(t.TempDir(), "consumers.json")
	purpose := testPurpose("openai-upstream")
	writeConsumerAccess(t, accessPath,
		map[string]any{"token": testCapability(71), "capabilityPath": filepath.Join(t.TempDir(), "one.json"), "purposes": []QualifiedPurpose{purpose},
			"modelCatalogs": []map[string]any{{"purpose": purpose, "sourceRevision": "admitted-source", "models": []map[string]any{{"id": "gpt-6.1-sol"}}}}},
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
			select {
			case <-r.Context().Done():
				close(canceled)
				return nil, r.Context().Err()
			case <-finish:
				return fixture.RoundTrip(r)
			}
		}
		return fixture.RoundTrip(r)
	})
	broker := &sequenceBroker{leases: []RequestAuthHeaders{validLease("first", nil), validLease("second", nil), validLease("second-current", nil)}}
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
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/responses", cfg.Port), strings.NewReader(`{"model":"gpt-6.1-sol","input":"first","stream":true}`))
	request.Header.Set("Authorization", "Bearer "+testCapability(71))
	request.Header.Set("Content-Type", "application/json")
	settled := make(chan error, 1)
	go func() {
		response, err := http.DefaultClient.Do(request)
		if response != nil {
			body, readErr := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err == nil && (readErr != nil || response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"type":"response.completed"`)) {
				err = fmt.Errorf("finite SSE did not complete: status=%d read=%v", response.StatusCode, readErr)
			}
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
	response := postJSON(t, other, "/v1/responses", `{"model":"gpt-6.1-sol","input":"second"}`)
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
		t.Fatal("settlement canceled admitted finite SSE work")
	case status := <-settlementResult:
		t.Fatalf("consumer released resources before its finite request finished: %d", status)
	case <-time.After(50 * time.Millisecond):
	}
	if _, retained := gateway.coreManager.GetByID(sourceModelClientID(testCapability(71), cfg.AuthEntries[0].ID)); !retained {
		t.Fatal("settlement removed a source client still needed by admitted work")
	}
	retired := cfg
	retired.DownstreamBearer = testCapability(71)
	response = postJSON(t, retired, "/v1/responses", `{"model":"gpt-6.1-sol","input":"new work"}`)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("retired consumer admitted new work: %d", response.StatusCode)
	}
	response = postJSON(t, other, "/v1/responses", `{"model":"gpt-6.1-sol","input":"still active while first settles"}`)
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
	select {
	case err := <-settled:
		if err != nil {
			t.Fatalf("finite admitted response did not complete: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first consumer did not settle")
	}
	if _, retained := gateway.coreManager.GetByID(sourceModelClientID(testCapability(71), cfg.AuthEntries[0].ID)); retained {
		t.Fatal("completed settlement retained the retired source client")
	}
}

func TestPinnedSDKSharedConsumerWithdrawalDuringBorrowPreservesAdmittedWork(t *testing.T) {
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
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/responses", cfg.Port), strings.NewReader(`{"model":"gpt-6.1-sol","input":"pending borrow"}`))
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
			t.Fatal("admitted request did not return a response")
		}
		body := readResponse(t, response)
		if response.StatusCode != http.StatusOK || len(upstream.requests()) != 1 {
			t.Fatalf("withdrawal vetoed admitted work: status=%d effects=%d body=%s", response.StatusCode, len(upstream.requests()), body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("revoked borrow did not settle")
	}
}
