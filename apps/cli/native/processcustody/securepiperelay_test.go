package main

import "testing"

func TestParseSecurePipeRelayOptions(t *testing.T) {
	options, err := parseSecurePipeRelayOptions([]string{
		`--pipe-name=\\.\pipe\happier-workspace-sync-test`,
		"--target-port=43127",
	})
	if err != nil {
		t.Fatalf("parse valid options: %v", err)
	}
	if options.pipeName != `\\.\pipe\happier-workspace-sync-test` || options.targetPort != 43127 {
		t.Fatalf("unexpected options: %#v", options)
	}
}

func TestParseSecurePipeRelayOptionsAdmitsSessionRpcPrefix(t *testing.T) {
	options, err := parseSecurePipeRelayOptions([]string{
		`--pipe-name=\\.\pipe\happier-session-rpc-test`,
		"--target-port=43127",
	})
	if err != nil || options.pipeName != `\\.\pipe\happier-session-rpc-test` {
		t.Fatalf("session-rpc prefix: %#v %v", options, err)
	}
}

func TestParseSecurePipeRelayOptionsAdmitsSessionTargetPrefix(t *testing.T) {
	options, err := parseSecurePipeRelayOptions([]string{
		`--pipe-name=\\.\pipe\happier-session-target-test`,
		"--target-port=43127",
	})
	if err != nil || options.pipeName != `\\.\pipe\happier-session-target-test` {
		t.Fatalf("session-target prefix: %#v %v", options, err)
	}
}

func TestParseSecurePipeRelayOptionsRejectsUnsafeInputs(t *testing.T) {
	for _, args := range [][]string{
		{"--target-port=43127"},
		{`--pipe-name=\\.\pipe\other`, "--target-port=43127"},
		{`--pipe-name=\\.\pipe\happier-workspace-sync-test`, "--target-port=0"},
		{`--pipe-name=\\.\pipe\happier-workspace-sync-test`, "--target-port=43127", "--extra"},
	} {
		if _, err := parseSecurePipeRelayOptions(args); err == nil {
			t.Fatalf("expected rejection for %#v", args)
		}
	}
}
