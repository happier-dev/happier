# Version and status evidence

Use this reference to decide whether an issue affects a reported release, current source, an installed artifact, or a mixed component deployment.

## Build the version vector

Record the components that can independently vary for the reported flow:

- UI application/web build and channel;
- CLI and daemon version/build;
- server/relay version and deployment type;
- provider CLI/runtime and connected-service profile when relevant;
- platform, architecture, installer/package source, and feature/capability state;
- persisted format or migration frontier when relevant.

Unknown fields remain unknown. Do not fill optional issue-template fields from current local defaults.

## Name every comparison basis

Keep these identities separate:

- **Reported basis:** exact versions/artifacts supplied by the reporter.
- **Source basis:** checkout, branch role, and commit inspected locally.
- **Loaded basis:** runtime, runner snapshot, bundle, installed binary, container, or deployed service actually exercised.
- **Fix basis:** commit or owner-level change that corrects the failure.
- **Release basis:** immutable version/tag plus artifact or deploy evidence containing the fix.

Rolling tags and current branch names are discovery pointers, not final release proof. Compose the provenance rules in `skills/happier-compatibility` rather than reconstructing old behavior from current types.

## Disposition rules

- Say **affects reported release** only when report evidence, a historical artifact/contract, or a faithful reproduction supports it.
- Say **reproduced current** only against the named loaded current basis.
- Say **fixed in source; release unproven** when current source contains the correction but no immutable released artifact has been mapped to it.
- Say **fixed in release X** only after commit-to-artifact or deploy provenance proves X contains the fix.
- Say **component skew** when the observed behavior follows from a reachable UI/CLI/daemon/server/provider version combination; name the incompatible direction.
- Say **regression** only when an earlier named basis is proven healthy and a later named basis is proven affected.
- Say **insufficient version basis** when missing identity prevents a material version conclusion; request only the fact that would resolve it.

Development builds can explain a report but are not permanent compatibility obligations. Stable and preview releases are treated according to `docs/compatibility.md`.

## Release response

When source is fixed but users remain affected, identify the release action separately from the source diagnosis:

- which component must be released or promoted;
- which channel would first carry it;
- whether a backport is needed;
- whether an artifact was built from the wrong commit or channel;
- what evidence would prove the reporter can receive the corrected artifact.

Route signing, packaging, publication, promotion, notarization, and artifact-identity defects to the appropriate `skills/happier-release*` authority.
