package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestQuoteWindowsArgumentRoundTripsThroughArgvDecoding(t *testing.T) {
	cases := []string{
		"plain",
		"",
		"with space",
		`quoted "inside"`,
		`trailing backslash \`,
		`backslash before quote \"`,
		"--port=43111",
		"C:\\Program Files\\Tool\\tool.exe serve",
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
	return out.String()
}

func TestParseRunArgsRequiresJobAndTarget(t *testing.T) {
	job, handshake, target, err := parseRunArgs([]string{
		"--handshake=C:\\tmp\\hs.json",
		"--job=Local\\happier-svc09-abc",
		"--",
		"tool.exe",
		"--serve",
		"443",
	})
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if job != `Local\happier-svc09-abc` || handshake != `C:\tmp\hs.json` {
		t.Fatalf("unexpected options: job=%q handshake=%q", job, handshake)
	}
	if len(target) != 3 || target[0] != "tool.exe" || target[2] != "443" {
		t.Fatalf("unexpected target: %v", target)
	}
	if _, _, _, err := parseRunArgs([]string{"--job=x", "tool.exe"}); err == nil {
		t.Fatalf("target before -- must be rejected")
	}
	if _, _, _, err := parseRunArgs([]string{"--", "tool.exe"}); err == nil {
		t.Fatalf("missing --job must be rejected")
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

func TestLocateStarttimeRequiresExactlyOneCandidate(t *testing.T) {
	build := func(sec uint64, usec uint32) []byte {
		buffer := make([]byte, 648)
		binary.LittleEndian.PutUint32(buffer[kinfoProcPidOffset:], 4242)
		// Put the candidate at an 8-aligned offset well past the pid field.
		binary.LittleEndian.PutUint64(buffer[80:], sec)
		binary.LittleEndian.PutUint32(buffer[88:], usec)
		return buffer
	}
	sec, usec, err := locateStarttime(build(1754041400, 123456), 4242, 1754041300, 1754041500)
	if err != nil || sec != 1754041400 || usec != 123456 {
		t.Fatalf("expected the single candidate, got sec=%d usec=%d err=%v", sec, usec, err)
	}
	if _, _, err := locateStarttime(build(1754041400, 123456), 9999, 1754041300, 1754041500); err == nil {
		t.Fatalf("a pid-field mismatch must fail closed")
	}
	if _, _, err := locateStarttime(build(1754041600, 123456), 4242, 1754041300, 1754041500); err == nil {
		t.Fatalf("an out-of-range seconds value must fail closed")
	}
	ambiguous := build(1754041400, 123456)
	binary.LittleEndian.PutUint64(ambiguous[160:], 1754041401)
	binary.LittleEndian.PutUint32(ambiguous[168:], 654321)
	if _, _, err := locateStarttime(ambiguous, 4242, 1754041300, 1754041500); err == nil {
		t.Fatalf("two candidates must fail closed")
	}
}
