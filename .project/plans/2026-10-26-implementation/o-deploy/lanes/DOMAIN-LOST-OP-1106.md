DONE — recovery committed in 717576ac290e; whole row in ba62b76502d9; composed regression in d350bf49c6f7; live #82 three retained Removes PASS (owner report).

| Check | Verdict | Evidence |
| --- | --- | --- |
| Constructed regression RED | PASS: not_found lacks recovery; unavailable stays busy | `.project/tmp/DOMAIN-LOST-OP-1106/red.log`, failure at test line 288 |
| Domain owner projection | PASS: fresh 4/4 | `fast-owner-green.log`, terminal0/session6894 |
| Full Environment tabs + real operation protocol reader | PASS: 33 tests across 2 files | `ui-green.log`; React act warnings retained |
| Typed missing / transient unavailable regression | PASS: fresh 2/2 | `fast-ui-green.log`, terminal0/session54815 |
| Post-ruling entry-loads / focused regression | PASS: 7/7 and 2/2, terminal0 | `commit-entry-loads.log` / `commit-ui-green.log`, sessions8744 /19065 |
| Stack version entry | PASS: 0.2.10 | `version.log` |
| Seven source entry graphs | PASS: 7/7, terminal exit 0 | `entry-loads.log`, original session 40770 |
| Deployments public build | PASS: terminal exit 0 | `build.log`, original session 92928, completed 21:53:33 UTC |
| Deployments public typecheck | No verdict: stopped during reset | `typecheck.log`; original 74472/cell93 no longer exists; no duplicate launched |
| UI package diagnostics | No delta claim | Shared package integration belongs to Systemic; no baseline supplied to this lane |
| Source commit | PASS: concurrent coarse commits, byte-equal HEAD | Projection/test/export/docs717576ac290e; whole rowba62b76502d9; composed regressiond350bf49c6f7 |
| Loaded recovery | PASS reported by owner: #82 three stuck Removes | Latest O-DEPLOY ruling in this session; no live QA/resource mutation from this lane |

Observed ownership and corridor:
- Server `removeDeploymentDomainInTx` persists removing + desired:false captures and the admitted operation identity; `projectDeploymentDomainHeader` emits its controller operationAddress.
- CLI `ownServerDomainActions` admits/removes against those captures and sends signed native observations; no state/removal-address producer was changed here.
- Protocol `ActionOperationGetV1ResponseSchema` already distinguishes found/not_found. Unavailable transport reads reject; they are not absence.
- Shared `projectDeploymentDomainFactsV1` now owns exact-operation lifecycle/recovery projection. The sole mounted row consumes it; the existing inline failure/cancellation decision was removed.
- The row binds typed absence to its exact Home/Account/controller/operation read key. Legacy records without an address retain desired state.
- Typed missing removal projects outcome_unknown with Technical details code not_found and Remove available. Persisted intent/captures remain, because missing execution history proves no native absence.
- UI full-page composition drives the genuine operation response parser and existing Domain Action handler; only RPC and deployment transport boundaries are fixtures.
- Existing failed Add, failed/cancelled Remove, wrong operation and scope, legacy/no-address, and pending/unavailable cases remain covered. No new RPC, persistence shape, schema, migration, Action, poll, or retry loop.
- Internal docs: only the six-line recovery paragraph after the `docs/deployment.md` lede is mine. This is unreleased 0.3 behavior, with no published guide change.

Self-review: all hunks serve lost-operation recovery or its proof. Existing status words, menu and Technical details are reused. No duplicate Domain recovery decision remains in the presenter; server desired-state and signed native absence remain distinct authorities.

11-07 fast coarse ruling supersedes producer waits and exact-tree finalizer. Current recovery owner/test/row bytes equal the post-edit entry7/7 basis and are now byte-equal to HEAD. The fresh focused owner4/4 and composed2/2 pass. A repeat entry check41905 remains queued (waiter cell11); it is supplementary, not a replacement verdict for the earlier terminal7/7. No source edit in this continuation; no duplicate source commit or push. Requested attribution: DeploymentDomainRow.tsx — orphan sweep / original Deployment UI lanes. Existing mounted UI/support modules and Protocol/DNS/provenance hunks co-landed through the current coarse commits. The lane handoff report is committed separately by private index/commit-tree/CAS.

Net mechanism delta: +1 scoped ephemeral missing-read state / −0 persisted states; +1 typed-not_found recovery branch, with existing terminal/scope projection moved to one owner; +0/−0 error codes, timers and automatic retries; +2/−0 source files (owner and tests). Four existing files change (export, row, composed test, docs).

Residual risk: no whole-package typecheck delta or pre-push HEAD coherence claim. Systemic owns per-wave package health and the pre-push coherence pass; no push authorized. The supplementary entry41905 remains queued on its original handle, with prior terminal7/7 explicitly reused only after verifying unchanged recovery bytes. #82 live acceptance is owner-reported, not independently rerun here. Two retained foreign EOF whitespace advisories were observed in the coarse candidate; no foreign source reformatted.
