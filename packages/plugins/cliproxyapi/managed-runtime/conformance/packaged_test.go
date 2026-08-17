package conformance

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	managedruntime "github.com/happier-dev/happier/packages/plugins/cliproxyapi/managed-runtime"
)

func TestPackagedWrapper(t *testing.T) {
	executable := os.Getenv("HAPPIER_CLIPROXYAPI_EXECUTABLE")
	if executable == "" {
		t.Skip("set HAPPIER_CLIPROXYAPI_EXECUTABLE to exercise a packaged managed wrapper")
	}
	wrapperBuildVersion := os.Getenv("HAPPIER_CLIPROXYAPI_WRAPPER_BUILD_VERSION")
	if wrapperBuildVersion == "" || strings.TrimSpace(wrapperBuildVersion) != wrapperBuildVersion {
		t.Fatal("set HAPPIER_CLIPROXYAPI_WRAPPER_BUILD_VERSION to the exact packaged wrapper build version")
	}
	executable, err := filepath.Abs(executable)
	if err != nil {
		t.Fatal(err)
	}

	const downstreamBearer = "packaged-downstream-bearer"
	commandEnvironment, credentialSentinels := minimalPackagedEnvironment()
	sensitiveMaterial := append(credentialSentinels, downstreamBearer)
	tempDir := t.TempDir()
	capabilityPath := filepath.Join(tempDir, "request-auth", "capability.json")
	runtimeDir := tempDir

	port := reservePort(t)
	command := exec.Command(executable)
	command.Env = append(commandEnvironment,
		"HOST=127.0.0.1",
		"PORT="+strconv.Itoa(port),
		managedruntime.DownstreamBearerEnvironmentVariable+"="+downstreamBearer,
		managedruntime.RequestAuthCapabilityPathEnvironmentVariable+"="+capabilityPath,
		managedruntime.ManagedPurposeConfigurationEnvironmentVariable+"="+
			`{"v":2,"purposes":[{"id":"codex","provider":"codex","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"openai-upstream","allowedHttpsOrigin":"https://chatgpt.com","protocols":["openai-chat","openai-responses"]},{"id":"claude","provider":"claude","consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},"purpose":"anthropic-upstream","allowedHttpsOrigin":"https://api.anthropic.com","protocols":["anthropic"]}]}`,
	)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	var healthEvidence []byte
	defer func() {
		assertNoSensitiveMaterial(t, map[string]string{
			"stdout": string(stdout.Bytes()),
			"stderr": stderr.String(),
			"health": string(healthEvidence),
		}, sensitiveMaterial)
		assertNoSensitiveFiles(t, runtimeDir, sensitiveMaterial)
	}()
	if err := command.Start(); err != nil {
		t.Fatalf("start packaged wrapper: %v", err)
	}
	waitResult := make(chan error, 1)
	go func() {
		waitResult <- command.Wait()
	}()
	stopped := false

	defer func() {
		if !stopped {
			stopProcess(t, command, waitResult)
			stopped = true
		}
	}()
	wantProtocols := []managedruntime.ProviderProtocol{
		managedruntime.ProtocolOpenAIChat,
		managedruntime.ProtocolOpenAIResponses,
		managedruntime.ProtocolAnthropic,
	}
	wantPurposes := []managedruntime.QualifiedPurpose{
		{
			Consumer: managedruntime.ContributionIdentity{
				PluginID: "happier.provider.cliproxyapi",
				LocalID:  "cliproxyapi",
			},
			Purpose: "openai-upstream",
		},
		{
			Consumer: managedruntime.ContributionIdentity{
				PluginID: "happier.provider.cliproxyapi",
				LocalID:  "cliproxyapi",
			},
			Purpose: "anthropic-upstream",
		},
	}
	healthIdentity, healthEvidence := awaitManagedHealthIdentity(t, port, waitResult, &stopped, stderr.String(), sensitiveMaterial)
	if healthIdentity.V != managedruntime.ManagedHealthIdentityVersion ||
		healthIdentity.ContractVersion != managedruntime.WrapperContractVersion ||
		healthIdentity.SDKVersion != managedruntime.PinnedSDKVersion ||
		healthIdentity.WrapperBuildVersion != wrapperBuildVersion ||
		!healthIdentity.ModelListEnabled ||
		!slices.Equal(healthIdentity.Protocols, wantProtocols) ||
		!slices.Equal(healthIdentity.Purposes, wantPurposes) {
		t.Fatalf("packaged health identity = %#v", healthIdentity)
	}
	assertStatus(t, port, "/v1/models", downstreamBearer, http.StatusOK)
	assertStatus(t, port, "/v0/management/config", downstreamBearer, http.StatusNotFound)
	assertModelRequestFailsClosed(t, port, downstreamBearer)
	if _, err := os.Stat(filepath.Join(runtimeDir, "request-auth", "cliproxyapi-runtime")); !os.IsNotExist(err) {
		t.Fatalf("wrapper created a private child directory beneath the host-owned root: %v", err)
	}
	if _, err := os.Stat(capabilityPath); !os.IsNotExist(err) {
		t.Fatalf("packaged wrapper wrote request-auth capability path before activation: %v", err)
	}

	stopProcess(t, command, waitResult)
	stopped = true
	if info, err := os.Stat(runtimeDir); err != nil || !info.IsDir() {
		t.Fatalf("wrapper removed host-owned materialized root after shutdown: info=%v err=%v", info, err)
	}
}

func awaitManagedHealthIdentity(
	t *testing.T,
	port int,
	waitResult <-chan error,
	stopped *bool,
	stderr string,
	sensitiveMaterial []string,
) (managedruntime.ManagedHealthIdentity, []byte) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		response, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return getManagedHealthIdentity(t, port)
			}
		}
		select {
		case err := <-waitResult:
			*stopped = true
			t.Fatalf(
				"packaged wrapper exited before HTTP health: %v; stderr=%s",
				err,
				redactPackagedDiagnostics(stderr, sensitiveMaterial),
			)
		case <-time.After(10 * time.Millisecond):
		}
	}
	t.Fatalf(
		"packaged wrapper HTTP health timed out; stderr=%s",
		redactPackagedDiagnostics(stderr, sensitiveMaterial),
	)
	return managedruntime.ManagedHealthIdentity{}, nil
}

func getManagedHealthIdentity(
	t *testing.T,
	port int,
) (managedruntime.ManagedHealthIdentity, []byte) {
	t.Helper()
	response, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
	if err != nil {
		t.Fatalf("packaged health request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("packaged health status = %d, want 200", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("packaged health content type = %q", got)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 512*1024))
	if err != nil {
		t.Fatalf("read packaged health identity: %v", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var identity managedruntime.ManagedHealthIdentity
	if err := decoder.Decode(&identity); err != nil {
		t.Fatalf("decode packaged health identity: %v", err)
	}
	return identity, body
}

func assertModelRequestFailsClosed(t *testing.T, port int, bearer string) {
	t.Helper()
	request, err := http.NewRequest(
		http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/v1/responses", port),
		bytes.NewBufferString(`{"model":"gpt-5.5","input":"must fail before capability activation"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+bearer)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("pre-activation model request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusBadRequest {
		t.Fatalf("pre-activation model status = %d, want fail-closed response", response.StatusCode)
	}
}

func stopProcess(t *testing.T, command *exec.Cmd, waitResult <-chan error) {
	t.Helper()
	if runtime.GOOS == "windows" {
		_ = command.Process.Kill()
	} else {
		_ = command.Process.Signal(syscall.SIGTERM)
	}
	select {
	case err := <-waitResult:
		if err != nil {
			t.Fatalf("packaged wrapper shutdown = %v", err)
		}
	case <-time.After(10 * time.Second):
		_ = command.Process.Kill()
		t.Fatal("packaged wrapper did not stop")
	}
}

func assertStatus(t *testing.T, port int, path, bearer string, want int) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
	if err != nil {
		t.Fatal(err)
	}
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer response.Body.Close()
	if response.StatusCode != want {
		t.Fatalf("GET %s status = %d, want %d", path, response.StatusCode, want)
	}
}

func reservePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

func minimalPackagedEnvironment() ([]string, []string) {
	result := make([]string, 0, 12)
	if runtime.GOOS == "windows" {
		for _, name := range []string{"SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"} {
			if value, ok := os.LookupEnv(name); ok {
				result = append(result, name+"="+value)
			}
		}
	} else if value, ok := os.LookupEnv("TMPDIR"); ok {
		result = append(result, "TMPDIR="+value)
	}

	sentinels := []struct {
		name  string
		value string
	}{
		{"OPENAI_API_KEY", "packaged-openai-api-key-sentinel"},
		{"CODEX_API_KEY", "packaged-codex-api-key-sentinel"},
		{"ANTHROPIC_API_KEY", "packaged-anthropic-api-key-sentinel"},
		{"ANTHROPIC_AUTH_TOKEN", "packaged-anthropic-auth-token-sentinel"},
		{"CLAUDE_CODE_OAUTH_TOKEN", "packaged-claude-oauth-token-sentinel"},
		{"MANAGEMENT_PASSWORD", "packaged-management-password-sentinel"},
	}
	values := make([]string, 0, len(sentinels))
	for _, sentinel := range sentinels {
		result = append(result, sentinel.name+"="+sentinel.value)
		values = append(values, sentinel.value)
	}
	return result, values
}

func redactPackagedDiagnostics(value string, sensitiveMaterial []string) string {
	const maximumDiagnosticBytes = 4096
	for _, sensitive := range sensitiveMaterial {
		if sensitive != "" {
			value = strings.ReplaceAll(value, sensitive, "[redacted]")
		}
	}
	if len(value) > maximumDiagnosticBytes {
		value = value[:maximumDiagnosticBytes] + "...[truncated]"
	}
	return value
}

func assertNoSensitiveMaterial(
	t *testing.T,
	evidence map[string]string,
	sensitiveMaterial []string,
) {
	t.Helper()
	for evidenceName, value := range evidence {
		for _, sensitive := range sensitiveMaterial {
			if sensitive != "" && strings.Contains(value, sensitive) {
				t.Errorf("%s exposed packaged credential material", evidenceName)
			}
		}
	}
}

func assertNoSensitiveFiles(t *testing.T, root string, sensitiveMaterial []string) {
	t.Helper()
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, sensitive := range sensitiveMaterial {
			if sensitive != "" && bytes.Contains(data, []byte(sensitive)) {
				t.Errorf("%s contains packaged credential material", path)
			}
		}
		return nil
	}); err != nil && !os.IsNotExist(err) {
		t.Errorf("scan packaged runtime files for credential material: %v", err)
	}
}
