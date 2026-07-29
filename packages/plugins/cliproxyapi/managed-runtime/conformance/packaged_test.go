package conformance

import (
	"bufio"
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
	runtimeDir := filepath.Join(tempDir, "runtime")
	if err := os.Mkdir(runtimeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	capabilityPath := filepath.Join(tempDir, "request-auth-capability.json")
	configPath := filepath.Join(tempDir, "managed-runtime.json")
	writePrivateJSON(t, configPath, map[string]any{
		"v":                   1,
		"materializationId":   "packaged-materialization",
		"wrapperBuildVersion": wrapperBuildVersion,
		"gateway": map[string]any{
			"downstreamBearer": downstreamBearer,
			"runtimeDir":       runtimeDir,
			"authEntries": []any{
				map[string]any{
					"id":       "codex",
					"provider": "codex",
					"purpose":  packagedPurpose("openai-upstream"),
				},
				map[string]any{
					"id":       "claude",
					"provider": "claude",
					"purpose":  packagedPurpose("anthropic-upstream"),
				},
			},
			"protocols":        []string{"openai-responses", "anthropic"},
			"modelListEnabled": true,
		},
		"requestAuth": map[string]any{
			"capabilityPath": capabilityPath,
		},
	})

	port := reservePort(t)
	command := exec.Command(executable, "--config", configPath)
	command.Env = append(commandEnvironment,
		"HOST=127.0.0.1",
		"PORT="+strconv.Itoa(port),
	)
	stdoutPipe, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
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

	readinessResult := make(chan managedruntime.Readiness, 1)
	scanError := make(chan error, 1)
	scanDone := make(chan struct{})
	go func() {
		defer close(scanDone)
		scanReadiness(io.TeeReader(stdoutPipe, &stdout), readinessResult, scanError)
	}()
	defer func() {
		defer func() {
			select {
			case <-scanDone:
			case <-time.After(time.Second):
				t.Error("packaged wrapper stdout scanner did not stop")
			}
		}()
		if !stopped {
			stopProcess(t, command, waitResult)
			stopped = true
		}
	}()
	var readiness managedruntime.Readiness
	select {
	case readiness = <-readinessResult:
	case err := <-scanError:
		t.Fatalf(
			"scan packaged readiness: %v; stderr=%s",
			err,
			redactPackagedDiagnostics(stderr.String(), sensitiveMaterial),
		)
	case err := <-waitResult:
		stopped = true
		t.Fatalf(
			"packaged wrapper exited before readiness: %v; stderr=%s",
			err,
			redactPackagedDiagnostics(stderr.String(), sensitiveMaterial),
		)
	case <-time.After(10 * time.Second):
		t.Fatalf(
			"packaged wrapper readiness timed out; stderr=%s",
			redactPackagedDiagnostics(stderr.String(), sensitiveMaterial),
		)
	}

	if readiness.ContractVersion != managedruntime.WrapperContractVersion ||
		readiness.SDKVersion != managedruntime.PinnedSDKVersion ||
		len(readiness.Protocols) != 2 ||
		len(readiness.Purposes) != 2 {
		t.Fatalf("packaged readiness = %#v", readiness)
	}
	healthIdentity, healthEvidence := getManagedHealthIdentity(t, port)
	if healthIdentity.V != managedruntime.ManagedHealthIdentityVersion ||
		healthIdentity.ContractVersion != managedruntime.WrapperContractVersion ||
		healthIdentity.SDKVersion != managedruntime.PinnedSDKVersion ||
		healthIdentity.WrapperBuildVersion != wrapperBuildVersion ||
		healthIdentity.MaterializationID != "packaged-materialization" ||
		!healthIdentity.ModelListEnabled ||
		len(healthIdentity.Protocols) != 2 ||
		len(healthIdentity.Purposes) != 2 {
		t.Fatalf("packaged health identity = %#v", healthIdentity)
	}
	assertStatus(t, port, "/v1/models", downstreamBearer, http.StatusOK)
	assertStatus(t, port, "/v0/management/config", downstreamBearer, http.StatusNotFound)
	assertModelRequestFailsClosed(t, port, downstreamBearer)
	assertNoFiles(t, runtimeDir)
	if _, err := os.Stat(capabilityPath); !os.IsNotExist(err) {
		t.Fatalf("packaged wrapper wrote request-auth capability path before activation: %v", err)
	}

	stopProcess(t, command, waitResult)
	stopped = true
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

func scanReadiness(
	stdout interface{ Read([]byte) (int, error) },
	readiness chan<- managedruntime.Readiness,
	scanError chan<- error,
) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 512*1024)
	readinessSent := false
	for scanner.Scan() {
		if readinessSent {
			continue
		}
		line := scanner.Bytes()
		var fields map[string]json.RawMessage
		if json.Unmarshal(line, &fields) != nil || len(fields) != 4 {
			continue
		}
		for _, field := range []string{"contractVersion", "sdkVersion", "protocols", "purposes"} {
			if _, ok := fields[field]; !ok {
				fields = nil
				break
			}
		}
		if fields == nil {
			continue
		}
		var value managedruntime.Readiness
		if err := json.Unmarshal(line, &value); err != nil {
			scanError <- err
			return
		}
		readiness <- value
		readinessSent = true
	}
	if err := scanner.Err(); err != nil {
		if !readinessSent {
			scanError <- err
		}
		return
	}
	if !readinessSent {
		scanError <- fmt.Errorf("readiness JSON line was not emitted")
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

func writePrivateJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func packagedPurpose(purpose string) map[string]any {
	return map[string]any{
		"consumer": map[string]any{
			"pluginId": "happier.provider.cliproxyapi",
			"localId":  "cliproxyapi",
		},
		"purpose": purpose,
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
		{"HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN", "packaged-request-auth-capability-sentinel"},
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
	}); err != nil {
		t.Errorf("scan packaged runtime files for credential material: %v", err)
	}
}

func assertNoFiles(t *testing.T, root string) {
	t.Helper()
	var files []string
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			files = append(files, path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("packaged wrapper persisted runtime files: %#v", files)
	}
}
