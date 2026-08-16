# Issue diagnosis report examples

These examples demonstrate stance and information selection. They are not templates, and their technical facts must never be reused without fresh evidence.

## Confirmed owner-level defect

> The Windows launch bug is real, but executable discovery is not the problem. The existing Windows resolver already produces the correct `.cmd` invocation; the terminal bridge drops one required spawn option before launching it, so the command is quoted again and exits before readiness.
>
> Preserve the resolver's complete result through the existing launch specification and runner. Do not detect `.cmd` files again in the runner or enable a second shell path—both would create another invocation owner. Direct executables and non-Windows paths remain unchanged.
>
> Keep the issue open through a native Windows regression and a named corrected artifact. The unrun Windows process gate is the material remaining risk.

This works because the opening answers validity, cause, owner, correction, rejected workaround, unchanged behavior, closure, and risk once, in one causal narrative.

## Evidence needed before implementation

> The UI error is real, but it only proves that the response matched none of the supported result shapes; it does not identify which daemon or transport path produced that response. A canonical incomplete result from the related issue cannot cause this message, so the two reports should not share a fix.
>
> Do not broaden the parser or treat unknown objects as success. First request the loaded UI, daemon, and server identities plus the response's non-sensitive top-level type, keys, status, and reason. That one vector will decide whether the correction belongs in transport unwrapping, a provenance-backed compatibility adapter, or update guidance.

There is no invented “after the fix” behavior and no implementation approval request. The missing discriminator is the recommendation.

## Several issues, one shared decision and one separate decision

> #210 and #230 need one stable CLI release: their source corrections are proven in development, but the stable artifacts remain affected. Cut a new immutable stable version through the corrected identity and macOS-finalization pipeline, verify exact version output and native launch, and keep both issues open until that artifact is proven.
>
> #268 is a separate decision. Release lag is visible, but the installed iOS build, loaded update, connected CLI/provider, and missing model are unknown. Collect that provenance before changing the model catalog or authorizing a mobile release.

Shared release work is explained once. The issue with a different evidence need is not forced into the same brief merely because all three involve publication.

## Avoid the form-shaped version

Do not restate the same conclusion under `User-facing problem`, `Status today`, `Recommended next move`, `GitHub disposition`, `Can close now?`, `Decision needed`, `Disposition`, and `Exact next action`. Use headings or a table when they clarify real differences, not to expose the investigation's internal checklist.
