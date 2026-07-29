package main

import (
	"os/exec"
	"reflect"
	"testing"

	"github.com/happier-dev/happier/packages/plugins/cliproxyapi/managed-runtime/internal/thirdpartynotices"
)

func TestParseTarget(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		input    string
		wantOS   string
		wantArch string
	}{
		{input: "darwin-amd64", wantOS: "darwin", wantArch: "amd64"},
		{input: "darwin-arm64", wantOS: "darwin", wantArch: "arm64"},
		{input: "linux-amd64", wantOS: "linux", wantArch: "amd64"},
		{input: "linux-arm64", wantOS: "linux", wantArch: "arm64"},
		{input: "windows-amd64", wantOS: "windows", wantArch: "amd64"},
		{input: "windows-arm64", wantOS: "windows", wantArch: "arm64"},
		{input: "linux-x64", wantOS: "linux", wantArch: "amd64"},
	}
	for _, tc := range testCases {
		target, err := parseTarget(tc.input)
		if err != nil {
			t.Fatalf("parseTarget(%q) error = %v", tc.input, err)
		}
		if target.goos != tc.wantOS || target.goarch != tc.wantArch {
			t.Fatalf("parseTarget(%q) = %#v", tc.input, target)
		}
	}
	for _, invalid := range []string{"", "freebsd-amd64", "linux-386", "windows-x86", "darwin"} {
		if _, err := parseTarget(invalid); err == nil {
			t.Fatalf("parseTarget(%q) error = nil", invalid)
		}
	}
}

func TestBuildInvocationOwnsReproducibleFlags(t *testing.T) {
	t.Parallel()

	invocation := buildInvocation(
		target{goos: "windows", goarch: "amd64"},
		"/tmp/happier-cliproxyapi-managed.exe",
		"1.2.3",
	)
	wantArgs := []string{
		"build",
		"-trimpath",
		"-buildvcs=false",
		"-ldflags=-s -w -X main.buildVersion=1.2.3",
		"-o",
		"/tmp/happier-cliproxyapi-managed.exe",
		"./cmd/happier-cliproxyapi-managed",
	}
	if !reflect.DeepEqual(invocation.args, wantArgs) {
		t.Fatalf("build args = %#v, want %#v", invocation.args, wantArgs)
	}
	if invocation.env["CGO_ENABLED"] != "0" ||
		invocation.env["GOOS"] != "windows" ||
		invocation.env["GOARCH"] != "amd64" {
		t.Fatalf("build env = %#v", invocation.env)
	}
}

func TestExecuteBuildVerifiesCheckedInNoticesAgainstExactBuiltTarget(t *testing.T) {
	t.Parallel()

	var events []string
	err := executeBuild(
		target{goos: "windows", goarch: "arm64"},
		"/tmp/happier-cliproxyapi-managed.exe",
		"1.2.3",
		"/opt/go/bin/go",
		"/repo/managed-runtime",
		func(command *exec.Cmd) error {
			events = append(events, "build")
			if command.Dir != "/repo/managed-runtime" {
				t.Fatalf("build cwd = %q", command.Dir)
			}
			return nil
		},
		func(context thirdpartynotices.Context, expectedPath string) error {
			events = append(events, "notices")
			if context.GoCommand != "/opt/go/bin/go" ||
				context.ModuleRoot != "/repo/managed-runtime" ||
				context.PackagePattern != "./cmd/happier-cliproxyapi-managed" ||
				context.BinaryPath != "/tmp/happier-cliproxyapi-managed.exe" {
				t.Fatalf("notice context = %#v", context)
			}
			if context.BuildEnv["CGO_ENABLED"] != "0" ||
				context.BuildEnv["GOOS"] != "windows" ||
				context.BuildEnv["GOARCH"] != "arm64" {
				t.Fatalf("notice build env = %#v", context.BuildEnv)
			}
			if expectedPath != "/repo/managed-runtime/licenses/THIRD-PARTY-NOTICES" {
				t.Fatalf("notice path = %q", expectedPath)
			}
			return nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(events, []string{"build", "notices"}) {
		t.Fatalf("events = %#v", events)
	}
}
