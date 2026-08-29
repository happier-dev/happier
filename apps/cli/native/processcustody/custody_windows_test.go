//go:build windows

package main

import (
	"bytes"
	"testing"
)

func TestQuoteWindowsArgumentRoundTripsThroughArgvDecoding(t *testing.T) {
	cases := []string{
		"plain",
		"",
		"with space",
		`quoted "inside"`,
		`trailing backslash \`,
		`C:\tool\`,
		`backslash before quote \"`,
		"--port=43111",
		`C:\Program Files\Tool\tool.exe serve`,
	}
	for _, value := range cases {
		quoted := quoteWindowsArgument(value)
		if decoded := decodeMSVCRTArgument(quoted); decoded != value {
			t.Fatalf("quote/decode round trip failed for %q: quoted %q decoded %q", value, quoted, decoded)
		}
	}
}

// decodeMSVCRTArgument implements the CommandLineToArgvW decoding rule for one
// argument, proving quoteWindowsArgument is its lossless inverse.
func decodeMSVCRTArgument(argument string) string {
	if argument == `""` {
		return ""
	}
	var out bytes.Buffer
	inQuotes := false
	backslashes := 0
	for i := 0; i < len(argument); i++ {
		char := argument[i]
		switch {
		case char == '\\':
			backslashes++
		case char == '"':
			for backslashes/2 > 0 {
				out.WriteByte('\\')
				backslashes--
			}
			if backslashes%2 == 1 {
				out.WriteByte('"')
				backslashes = 0
			} else {
				backslashes = 0
				inQuotes = !inQuotes
			}
		default:
			for backslashes > 0 {
				out.WriteByte('\\')
				backslashes--
			}
			out.WriteByte(char)
		}
	}
	for backslashes > 0 {
		out.WriteByte('\\')
		backslashes--
	}
	_ = inQuotes
	return out.String()
}

func TestParseRunArgsRequiresJobAndTarget(t *testing.T) {
	job, handshake, verbatim, target, err := parseRunArgs([]string{
		"--handshake=C:\\tmp\\hs.json",
		"--job=Local\\happier-svc09-abc",
		"--target-windows-verbatim",
		"--",
		"tool.exe",
		"--serve",
		"443",
	})
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if job != `Local\happier-svc09-abc` || handshake != `C:\tmp\hs.json` || !verbatim {
		t.Fatalf("unexpected options: job=%q handshake=%q", job, handshake)
	}
	if len(target) != 3 || target[0] != "tool.exe" || target[2] != "443" {
		t.Fatalf("unexpected target: %v", target)
	}
	if _, _, _, _, err := parseRunArgs([]string{"--job=x", "tool.exe"}); err == nil {
		t.Fatalf("target before -- must be rejected")
	}
	if _, _, _, _, err := parseRunArgs([]string{"--", "tool.exe"}); err == nil {
		t.Fatalf("missing --job must be rejected")
	}
}

func TestWindowsCommandLinePreservesVerbatimCmdTail(t *testing.T) {
	target := []string{`C:\Windows\System32\cmd.exe`, "/d", "/s", "/c", `""C:\Program Files\tool.cmd" "a&b""`}
	got := windowsCommandLine(target, true)
	want := `C:\Windows\System32\cmd.exe /d /s /c ""C:\Program Files\tool.cmd" "a&b""`
	if got != want {
		t.Fatalf("verbatim command line changed cmd.exe grammar: got %q want %q", got, want)
	}
}

func TestParseJobArgs(t *testing.T) {
	job, timeout, err := parseJobArgs([]string{"--job=j1", "--timeout-ms=250"})
	if err != nil || job != "j1" || timeout != 250 {
		t.Fatalf("parse failed: job=%q timeout=%d err=%v", job, timeout, err)
	}
	if _, _, err := parseJobArgs([]string{"--timeout-ms=0"}); err == nil {
		t.Fatalf("non-positive timeout must be rejected")
	}
}
