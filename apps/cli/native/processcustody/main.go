// Command happier-process-custody is the single first-party native helper behind
// SVC09's exact process-tree custody. It is a runtime support binary staged under
// `tools/unpacked` by the daemon-support payload builder; it is never a plugin
// contribution and never resolves anything on its own.
//
// Platforms:
//   - windows: `run --job=<name> -- <target...>` creates the named Job Object,
//     starts the target suspended, assigns it to the job before its first
//     instruction, resumes it, and waits. `terminate` / `query` act on a job by
//     name and prove full membership absence. Stdin/stdout/stderr and the
//     environment are the caller's, inherited unchanged by the target.
//     `run --wait-for-job-empty` retains natural descendants until the same
//     job is positively empty, then returns the observed target-root code.
//   - darwin: `pid-startidentity <pid>` reports the native subsecond process
//     start identity (kinfo_proc p_starttime) via the numeric sysctl MIB
//     {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid}. The parse is validated at
//     runtime and fails closed instead of guessing a layout.
//   - linux/darwin/windows: `peer-identity [--pipe-handle=<handle>]` inspects
//     the inherited accepted local IPC connection (fixed extra descriptor 3,
//     never a path in argv) with the platform's real peer primitive —
//     SO_PEERCRED on Linux, LOCAL_PEERPID plus LOCAL_PEERCRED on Darwin,
//     GetNamedPipeClientProcessId on
//     Windows — and emits the one proven peer identity or fails closed.
//   - windows: `secure-pipe-relay` creates a current-user-only named pipe,
//     witnesses each exact client PID, and relays opaque bytes to one fixed
//     TypeScript-owned loopback broker. It never parses broker messages.
//   - darwin/windows: `workspace-confined-read` and `workspace-confined-delete` hold
//     a no-follow root-to-leaf handle chain across a two-phase authorization
//     exchange before disclosing bytes or mutating the exact held object.
//   - darwin/windows: `workspace-confined-observe` and `workspace-confined-capture`
//     provide complete entry identity and file-backed reviewed bytes. Linux uses
//     its existing retained-descriptor TypeScript owner for those two operations.
//   - linux/darwin/windows: `workspace-confined-apply` and
//     `workspace-confined-recover` provide no-clobber replacement and disposition.
//   - any other platform: every subcommand fails closed; Linux SVC09 custody
//     stays on its process-group owner and never consumes this helper.
//
// One JSON line goes to stdout for machine-readable outcomes; diagnostics go to
// stderr. Exit codes: 0 success, 2 usage, 3 custody outcome not proven, 4
// custody could not be established, 5 platform/OS error.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const (
	exitOK             = 0
	exitUsage          = 2
	exitNotProven      = 3
	exitNotEstablished = 4
	exitOSError        = 5
)

// emit writes the one machine-readable outcome line for this invocation.
func emit(payload map[string]any) error {
	payload["v"] = 1
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(append(encoded, '\n'))
	return err
}

func usage() {
	fmt.Fprintln(os.Stderr, strings.TrimSpace(`
usage:
  happier-process-custody run --job=<name> [--wait-for-job-empty] [--target-windows-verbatim] [--target-inherited-stdin-arg=<arg>] -- <command> [args...]
  happier-process-custody terminate --job=<name> [--timeout-ms=<ms>]
  happier-process-custody query --job=<name>
  happier-process-custody pid-startidentity <pid>
  happier-process-custody peer-identity [--pipe-handle=<handle>]
  happier-process-custody secure-pipe-relay --pipe-name=<name> --target-port=<port>
  happier-process-custody workspace-confined-read
  happier-process-custody workspace-confined-delete
  happier-process-custody workspace-confined-observe
  happier-process-custody workspace-confined-capture
  happier-process-custody workspace-confined-apply
  happier-process-custody workspace-confined-inspect
  happier-process-custody workspace-confined-recover`))
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
		os.Exit(exitUsage)
	}
	command, rest := args[0], args[1:]
	var err error
	switch command {
	case "run":
		err = runCustodyCommand(rest)
	case "terminate":
		err = terminateCustodyJob(rest)
	case "query":
		err = queryCustodyJob(rest)
	case "pid-startidentity":
		err = pidStartIdentityCommand(rest)
	case "peer-identity":
		err = peerIdentityCommand(rest)
	case "secure-pipe-relay":
		err = securePipeRelayCommand(rest)
	case "workspace-confined-read":
		err = workspaceConfinedReadCommand(rest, os.Stdin, os.Stdout)
	case "workspace-confined-delete":
		err = workspaceConfinedDeleteCommand(rest, os.Stdin, os.Stdout)
	case "workspace-confined-observe":
		err = workspaceConfinedObserveCommand(rest, os.Stdin, os.Stdout)
	case "workspace-confined-capture":
		err = workspaceConfinedCaptureCommand(rest, os.Stdin, os.Stdout)
	case "workspace-confined-apply":
		err = workspaceConfinedApplyCommand(rest, os.Stdin, os.Stdout)
	case "workspace-confined-inspect":
		err = workspaceConfinedInspectCommand(rest, os.Stdin, os.Stdout)
	case "workspace-confined-recover":
		err = workspaceConfinedRecoverCommand(rest, os.Stdin, os.Stdout)
	default:
		usage()
		os.Exit(exitUsage)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "happier-process-custody:", err.Error())
		os.Exit(exitOSError)
	}
}
