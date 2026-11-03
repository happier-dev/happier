# Organization policy

Organization policy supplies machine-level defaults and locks for the Tauri desktop app and the CLI/daemon on that machine. It keeps Account-service selection, Home selection, Personal Home admission, feature decisions, and local Iroh relay configuration at their existing owners.

**Release basis:** unreleased 0.3 development. This page describes the v1 contract; it does not establish stable or preview availability. The operator guide is [Organization policy](../apps/docs/content/docs/self-hosting/organization-policy.mdx).

## Scope and authority

The system administrator supplies one JSON file. The desktop and CLI read it independently at process startup. Policy is local machine configuration, not Account settings, a Team policy, or server-owned state. Browser and mobile clients do not read it.

Policy does not distribute itself, protect against a modified binary, or replace filesystem administration. Administrators must control the file and its parent directory. The file contains no credentials, tokens, private keys, or other secrets.

Account service, Home, and Iroh transport relay remain separate destinations. Selecting an Account service does not select a Home. Configuring Iroh relays does not select either service or Home.

## File boundary and lifecycle

| Platform | Machine policy file |
| --- | --- |
| macOS | `/Library/Application Support/Happier/policy.json` |
| Linux | `/etc/happier/policy.json` |
| Windows | `<KnownFolder ProgramFiles>\Happier\policy.json` |

Windows resolves the operating system's Program Files known folder; an environment-expanded `%ProgramFiles%` path is not its authority. Production builds have no user-selected file path. There are no plist, registry, or mobile MDM sources in v1.

The Rust desktop boundary reads the bytes before window creation and supplies them through the existing `web_runtime_config.rs` initialization script. Rust does not parse a second policy schema. The CLI reads the same machine file at `Configuration` construction. Each process retains its startup result; editing or removing the file requires restarting the affected desktop, CLI, and daemon processes. A client reconnect is insufficient to reload a daemon's policy.

An absent file resolves to unmanaged after one file open/stat attempt. There is no watcher, polling, network fetch, or policy subprocess. A present unreadable or invalid file resolves to a typed invalid result, never to absent.

## Schema owner

`packages/protocol/src/organizationPolicy/organizationPolicyV1.ts` owns the strict, versioned Zod schema, parsing result, errors, and lock metadata. Shared profile field definitions live alongside it in `buildDefaultProfile.ts`. The existing `resolveBuildDefaultProfile` API in `packages/cli-common/src/happierCloud.ts` consumes and re-exports those definitions; policy does not introduce a competing profile parser.

The required document identity is `schemaVersion: 1` and a nonempty `organization`. Optional `supportUrl` supplies the organization's support destination. Unknown fields, unknown feature ids, unsupported versions, malformed URLs, and inconsistent relay configuration are invalid. Diagnostic issues identify a field path and issue code without echoing the rejected value.

For the exact accepted field shapes, use the schema owner rather than maintaining a separate settings catalog here. A complete deployment example appears in the operator guide.

## Precedence and projection

For fields with defaults and locks, effective precedence is:

```text
built-in < baked build default < organization policy default
         < explicit user choice < organization policy lock
```

A policy default fills an unset choice. Each supplied `accountService`, `home`, or `personalHome` field requires an explicit boolean `locked`: `false` supplies a default; `true` fixes that field's effective value and refuses selection changes at its existing owner. Policy does not overwrite saved user choices with its projected values; setting the lock to `false` or removing the field and restarting restores normal selection precedence.

Feature denies and forced relay configuration have their own semantics below. They are not editable defaults.

### Account service

`resolveSelectedAccountServiceEndpoint` owns the effective Account-service endpoint. An unlocked policy endpoint supplies its default; an explicit saved selection wins. A locked endpoint wins over saved or caller-supplied alternatives, and `setAccountServiceEndpoint` refuses a selection change while locked.

Selection continues through the existing Account-service discovery and sign-in flow. Policy does not migrate identity or grant access to an alternate service.

### Home

`readConfiguredServerUrlEnv` owns the configured Home URL input. A policy default participates below explicit choice; a locked URL feeds the existing setup policy's `enforcedServerUrl`. Home selection paths, including URL/QR entry, tabs, and environment configuration, consume that owner instead of deciding a separate exception.

The lock constrains selection. It does not stop or delete an existing Home, rewrite its identity, or remove its data.

### Personal Home

`resolvePersonalHomeAdmission` in `setupSurfacePolicy.ts` owns `auto`, `offer`, and `off`. It combines the existing platform and setup-policy facts with the effective profile/policy value. Automatic bootstrap requires `auto`; `offer` exposes the full Personal Home bootstrap when chosen; `off` prevents new local Personal Home installation.

Existing Home lifecycle and recovery remain available. A policy change does not stop or delete an already installed Home. Allowing organization policy to choose `off` is an owner assumption pending veto, recorded in the approved synthesis; its scope is new installs only.

The local `relayHostEngine` also consumes the startup policy through its existing `localInstallPolicy` input at the install boundary. It rejects a fresh Personal Home install for an invalid policy or effective `off`, while retained Home purpose or preserved data keeps existing-runtime lifecycle and recovery separate from new installation.

### Features

`features.deny` adds deny-only input to the existing UI and CLI build-policy owners. It cannot force a feature on or fabricate a server-enabled bit. The canonical feature decision engine still applies server narrowing and feature dependencies. See [Feature gating](feature-gating.md).

### Iroh relays

`relays` is forced configuration for the local Home/daemon, projected into the existing `IrohRelayEnvConfig` contract. `automatic` can carry a configured relay URL list; `disabled` cannot carry relay URLs. This does not disable ordinary Home/server connectivity.

`resolveDaemonServiceIrohRelayConfig` gives the startup policy priority over process and installed-service inputs. The local `relayHostEngine` applies the same forced relay settings to its install environment. Neither consumer reparses the policy file.

The policy does not implement relay defaults, editable user-added relay lists, or restrictions on the desktop's peer candidates when connecting to other people's Homes. The existing Iroh owner remains responsible for transport behavior.

## Invalid policy and locked presentation

Invalid policy produces a visible typed diagnostic. First-run installation and Account-service/Home selection fail closed until the file is corrected or removed and the owning process restarts. Other runtime and recovery paths continue; invalid policy is not a reason to exit the whole app or daemon.

Lock metadata comes from the owning projection. The shared locked-control affordance displays **Managed by {organization}**, disables the governed control, exposes an accessible explanation, and offers `supportUrl` when supplied. Consumers do not infer a lock from a URL or reparse the document.

Action diagnostics distinguish `organization_policy_invalid`, `organization_policy_locked`, and `organization_policy_off`. Read failures preserve a typed issue such as `organization_policy_unreadable`, `organization_policy_invalid_utf8`, or `organization_policy_path_unavailable`. Diagnostics contain schema/file locations and codes, never raw policy contents or rejected values.

## Verification boundary

Owner-level coverage must distinguish absent, default, locked, lock removal, invalid, and bypass attempts. The composed implementation check starts the Linux desktop with no file and then with a locked file, and exercises the reachable Account-service, Home, and Personal Home paths.

macOS/Windows startup absence cost and signed-installer behavior are named release checks. They are not implied by source tests or a Linux desktop run. There is no measured zero-cost startup claim.

## Related

- [Feature gating](feature-gating.md) — feature catalog and decision engine ownership.
- [CLI architecture](cli-architecture.md) — Configuration and daemon lifecycle.
- [Organization policy operator guide](../apps/docs/content/docs/self-hosting/organization-policy.mdx) — deployment and recovery.
