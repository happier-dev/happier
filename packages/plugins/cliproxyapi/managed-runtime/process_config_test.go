package managedruntime

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLoadProcessConfigAcceptsOnlyStrictPrivateV1Document(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "managed-runtime.json")
	writeProcessConfigFixture(t, path, "")
	config, err := LoadProcessConfig(path)
	if err != nil {
		t.Fatalf("LoadProcessConfig() error = %v", err)
	}
	if config.V != 1 || config.Gateway.DownstreamBearer != "session-secret" {
		t.Fatalf("config = %#v", config)
	}
	if config.WrapperBuildVersion != "0.2.9" {
		t.Fatalf("wrapper build version = %q", config.WrapperBuildVersion)
	}
	if config.MaterializationID != "materialization-current" {
		t.Fatalf("materialization id = %q", config.MaterializationID)
	}
	if config.RequestAuth.CapabilityPath != "/private/request-auth-capability.json" {
		t.Fatalf("request-auth config = %#v", config.RequestAuth)
	}

	writeProcessConfigFixture(t, path, `,"capability":"must-never-be-copied"`)
	if _, err := LoadProcessConfig(path); err == nil {
		t.Fatal("unknown secret-bearing field was accepted")
	}

	writeProcessConfigFixture(t, path, "")
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadProcessConfig(path); err == nil || !strings.Contains(err.Error(), "permissions") {
			t.Fatalf("broad permissions error = %v", err)
		}
	}
}

func TestLoadProcessConfigRejectsWrongVersionAndRelativePath(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "managed-runtime.json")
	writeProcessConfigFixture(t, path, "")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Replace(string(data), `"v":1`, `"v":2`, 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadProcessConfig(path); err == nil {
		t.Fatal("unsupported process config version was accepted")
	}
	if _, err := LoadProcessConfig("relative-config.json"); err == nil {
		t.Fatal("relative process config path was accepted")
	}
}

func TestLoadProcessConfigRejectsMissingOrMalformedMaterializationIdentity(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "managed-runtime.json")
	writeProcessConfigFixture(t, path, "")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"", " materialization-current ", strings.Repeat("m", 257)} {
		contents := strings.Replace(
			string(data),
			`"materializationId":"materialization-current"`,
			`"materializationId":"`+invalid+`"`,
			1,
		)
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadProcessConfig(path); err == nil {
			t.Fatalf("invalid materialization identity %q was accepted", invalid)
		}
	}
}

func TestLoadProcessConfigRejectsMissingOrMalformedWrapperBuildVersion(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "managed-runtime.json")
	writeProcessConfigFixture(t, path, "")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, replacement := range []string{
		``,
		`"wrapperBuildVersion":"",`,
		`"wrapperBuildVersion":" 0.2.9 ",`,
	} {
		contents := strings.Replace(
			string(data),
			`"wrapperBuildVersion":"0.2.9",`,
			replacement,
			1,
		)
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadProcessConfig(path); err == nil {
			t.Fatalf("invalid wrapper build replacement %q was accepted", replacement)
		}
	}
}

func writeProcessConfigFixture(t *testing.T, path, extra string) {
	t.Helper()
	contents := `{
		"v":1,
		"materializationId":"materialization-current",
		"wrapperBuildVersion":"0.2.9",
		"gateway":{
			"downstreamBearer":"session-secret",
			"runtimeDir":"/private/runtime",
			"authEntries":[{
				"id":"codex",
				"provider":"codex",
				"purpose":{
					"consumer":{"pluginId":"happier.provider.cliproxyapi","localId":"cliproxyapi"},
					"purpose":"openai-upstream"
				}
			}],
			"protocols":["openai-responses"],
			"modelListEnabled":false
		},
		"requestAuth":{
			"capabilityPath":"/private/request-auth-capability.json"
		}` + extra + `
	}`
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}
