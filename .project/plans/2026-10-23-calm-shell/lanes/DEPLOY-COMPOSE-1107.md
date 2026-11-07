STATUS: DONE — composition decided 13:24Z; RESULT posted on HANDOFF board: 7 journeys → 15 pages → 7 page lanes (L-A…L-G, disjoint files); 1 lab (Overview with several servers); 26 missing-fact groups for O-DEPLOY (5 proposed Tier 2). Specs below; no source changed.

# DEPLOY-COMPOSE-1107 — page composition for Deployments Tier 1 and Tier 2 (Opus, design decisions before page lanes)

Coordination RULING 2026-11-07 13:09Z: O-DEPLOY Tiers 1+2 are approved for 0.3. The build order is: UI refinements decides each page's composition and which existing components and patterns it reuses, THEN O-DEPLOY's lanes split by page, consuming existing Actions through the executor with no new local logic or primitives. This lane is that composition step.

Load `.agents/skills/happier-ui-craft`, `DESIGN.md`, `make-interfaces-feel-better`. Export HAPPIER_STACK_REPO_DIR=/home/leeroy.guest/.happier-stack/workspace/0.3.

## Read
- `.project/plans/2026-10-26-implementation/o-deploy/lanes/LAB-GAP-CAUSE-1107.md` (raw rows `.project/tmp/LAB-GAP-CAUSE-1107/gaps.json`), and O-DEPLOY's tier list on the board (posts from O-DEPLOY to Coordination on 11-07). The Tier 2 additions per the ruling: backup history + S3 Test destination, the missed-backup notice, the PR preview ready/URL fact.
- Deployments plans `.project/plans/2026-10-24-servers-and-deployments/40-*.md … 45-*.md`, and the O-DEPLOY lab scenes those rows point to.
- `.project/OWNER-RULINGS.md` 2026-11-07 "Agent actions: one shared flow". "Ask an agent to set it up" and "Fix this failed deploy" use the shared AgentActionButton (committed aca1f3a2f0) and the prefilled composer docked beside the item. No deploy-specific agent flow.
- Existing shared owners to reuse: plugin-ui components (Collection, Item, catalog rows, EmptyState, PageLoadingRows, detail navigation items / companions per Plan T `T-detail-navigation.md`), the Projects/Environment pages, and Settings catalog rows.

## Output: one composition spec per page (no code)
For each Tier 1 and Tier 2 page or screen:
- **Entry and place:** where the person reaches it; does it open in place (owner rule) or as a companion.
- **Anatomy:** the header (title, status word, primary action), sections in order, and which existing component renders each one (name the file).
- **States:** loading (in-place rows), empty, failed (one message plus next action), partial.
- **Actions:** each control mapped to its existing Action id, and the agent path through the shared agent-action flow.
- **Phone recomposition** at 390.
- **Reuse rules and forbidden items:** no new primitives, and name any near-duplicate component the page lane must not create.

Group pages that share an anatomy, so O-DEPLOY's page lanes can split cleanly. Mark any page that needs a lab because the composition is genuinely uncertain (at most 2 options). Write the specs here and post one RESULT to O-DEPLOY, Coordination and UI refinements. If a needed fact or component truly doesn't exist, list it as a Tier 2 backend fact for O-DEPLOY; don't design around it.

---

# Composition spec (UI refinements decision, 2026-11-07)

## Verdict
- **The 7 journeys map onto 15 pages in 7 page groups, one page lane each (L-A to L-G).** Most of the 116 Tier 1 scenes are states of 5 existing pages: Overview, Receipt, Variables, Domains and Settings. 3 pages are new: the Database page, the Logs companion and the PR preview section.
- **1 lab:** Overview section order with several servers (§5). Everything else is decided here.
- **Missing facts:** 26 groups of BP/BM rows are outside O-DEPLOY's three Tier 2 lanes, and no page designs around them. 5 of them touch a core journey or data safety and are proposed as Tier 2 (§7).
- **Basis:** current source and plans, read 13:15–13:35Z. Nothing was rendered or changed. Each page lane renders its page and gets whole-page Opus acceptance per journey.

## 0. Seam and inputs
- **One decider:** TIER1-COMPOSE-1107 (O-DEPLOY, 13:10Z ASK on the implementation BOARD) asked UI refinements for exactly these decisions. This file is that answer.
  - TIER1-COMPOSE consumes it for lab cleanup (delete the 4 NIP scenes, redraw `push/on` and `stored/movePathTaken`, keep the plan's `review/promoteBuild` rule) and for assigning files to lanes. It does not write a second composition.
  - If it finds a wrong fact here, it posts to DEPLOY-COMPOSE-1107/UI refinements and this file changes.
- **Tier scope:**
  - Tier 1 = the UI-ONLY and VARIANT rows of LAB-GAP-CAUSE-1107.
  - Tier 2 = T2-RECEIPT, T2-DATA and T2-DOMAIN-PREVIEW (O-DEPLOY 13:10Z BOARD post), plus the ruling's additions: backup history, S3 Test, missed-backup notice and PR preview ready/URL.
  - A state marked **(T2-x)** renders when that lane's fact lands. A state marked **(§7)** has no producer: its page shows nothing for it.
- **Read:** LAB-GAP-CAUSE-1107 (all 208 rows), LAB-COVERAGE-1107, P44 §6–7, Plan T (Flows, One resolved list, U6, U7), and OWNER-RULINGS rows 509/518. Source: `apps/ui/sources/components/projects/deployments/*`, `packages/deployments/src/projection/deploymentEnvironmentNavigation.ts`, `detailNavigationItems.ts`, `packages/plugin-ui/src/components/{AgentActionButton,PageLoadingRows,State,CollectionToolbar,CollectionConditionTokens}.tsx`, `components/approvals/DeploymentReviewApprovalFacts.tsx`, `components/sessions/new/components/NewSessionDockedHost.tsx`, the Action specs, and the plugin manifests (machine-services, backup-destinations, deployment-neon/-supabase, scm-github).

## 1. Shell rules for every page lane (the settled pattern wins over older lab pixels)
| # | Rule | Owner to consume | Lab deviation it causes |
|---|---|---|---|
| R1 | **Open in place.** An Environment opens in Project → Deployments list-detail. Receipt, Database, Logs, add/review sheets and the docked composer open inside the Environment, and the Projects section stays. Drag to split adds a pane. | `ProjectDeploymentsBody.tsx` (`HappierListDetailLayout`), NAV-INPLACE-1106 | Data → Add no longer leaves for Store (today `buildPluginsHomeRoute`) |
| R2 | **Detail navigation is one list.** The six pages Overview · History · Variables · Domains · Permissions · Settings come from the canonical ids. Two companions are added at that same owner: `logs` (companion) and the shared Session companion. No new tab, no local list. | `deploymentEnvironmentNavigation.ts` → `detailNavigationItems.ts` → `environmentNavigation.tsx` (Plan T U6); Session companion = the Triage-built mechanism (`pageItems` + `openedFrom`, `triage/src/ui/detail/sessionCompanion.tsx`). If that mechanism is still Triage-local, lift it to the shared owner; never copy it. | lab "Service logs · pane" becomes a companion |
| R3 | **One failure, one message, one next action.** Each page has one **attention slot** under the tabs. It shows only the highest-precedence notice: blocking/offline > failed > needs you > info. Lower notices stay visible in their own rows (amber/rose glyphs). The precedence is decided once, in `deploymentPresentation.ts` (it already owns `deploymentStateNotice`/`deploymentActionRefusalRemedy`). The action says "Retry", never "Try again". | `AttentionBanner`, `SurfaceStateCard`, `SurfaceFreshnessLine`, `deploymentPresentation.ts` | today's Overview can stack offline line + noTarget banner + outcome banner + unverified banner + secrets notice |
| R4 | **Agent entry points.** Every agent entry is `AgentActionButton` + the prefilled New Session composer docked beside the item. The resulting Session appears in the Environment's Session companion. There are three deployment action records in the shared catalog: **Set it up** (no Compose/Dockerfile), **Fix this deploy** (failed receipt), **Investigate** (unhealthy service, failing check, missed backup, platform failure). An unresolved placement opens the composer. Remove the deployment use of `InvestigationOutcomeBanner`'s placement-choice banner. `deployments.prepare` stays the agent/CLI Action behind **Set it up**, with one instruction owner and no second flow. | `packages/plugin-ui/src/components/AgentActionButton.tsx`, `NewSessionDockedHost.tsx`, AGENT-ACTIONS-MAP seam (catalog + Launch Profile + openNewSession) | receipt "Investigate" banner with placement picker |
| R5 | **Loading is shaped like content.** Page-level loading uses `PageLoadingRows` (plugin-ui) with the header reserved; it replaces the loading `SurfaceStateCard`s in `ProjectDeploymentsBody`, `AllDeploymentsScreen` and `DeploymentReceiptDetail`. A section whose existence is known reserves its rows and shows last-known data while refreshing. | `PageLoadingRows` | — |
| R6 | **Filters live in the search field** (funnel → tokens). No chip rows. | `CollectionToolbar` + `CollectionConditionTokens` | `d2d/byfilter`, `d2d/filterempty` chips |
| R7 | **Attention colours.** Amber = needs you, rose = failed, healthy = quiet ink. Glyphs stay ink, and the status word carries meaning without colour. | `StatusPill`, `WorkStatusGlyph`, `RowStatusLine` | — |
| R8 | **Settings holds deliberate preferences only.** Account Settings → Deployments keeps defaults. Everything per Environment lives on the Environment record (its Settings tab is the record's own configuration). Observed state (last backup, late heartbeat, drift) is a row fact, never a setting. | `DeploymentsSettingsView.tsx`, `DeploymentCreationDefaultsRows.tsx` | — |
| R9 | **Phone at 390.** The same Environment bottom bar appears on every Environment page. Pushed details (Receipt, Database, Logs, Session) keep it. The primary action goes in `PagePinnedBar`. Header actions hang from the name line, with ⋯ only. | `EnvironmentCockpitTabBar` via `usePresentedDetailNavigation`, `PagePinnedBar` | — |
| R10 | **Reviews use existing presenters.** A consequential operation reviews through the shared approval presenter or an existing sheet. No new sheet kind. | `ApprovalDetailScreen` + `DeploymentReviewApprovalFacts.tsx`, `ApprovalInboxCard`; sheets `DeploymentPromotionSheet`, `DeploymentRestoreSheet`, `DeploymentDispositionSheet`, `DeploymentLinkMachineSheet`, `DeploymentPlatformTargetSheet` via `deploymentSheet.ts` | — |

**Forbidden in every lane (near-duplicates):**
- a deployment-local agent button, sheet or Session list;
- a second banner stack or a local notice ordering;
- a filter chip row;
- a page-local loading skeleton;
- a second catalog/template list, a second secret row or picker, a second log viewer, or a second domain row;
- a new tab, router or destination builder (extend the owners named above);
- an inline Action-id array (consume the `actionIds*` exports).

## 2. Journeys → pages (acceptance is per journey, person path and agent path together)
| J | Journey (person) | Pages and states it crosses | Agent path (same Actions) | Accepted when |
|---|---|---|---|---|
| J1 | **First deploy.** Project → Deployments (empty) → + → draft → choose a Machine (not ready → setup review) → Create → Overview "Nothing deployed" → Deploy → review → live receipt → Serving now. Without Compose: **Set it up** → composer beside → PR → Deploy. | P13 → P1 → P4 → P3 → P1 | `deployments.environments.create`, `machines.setup.apply`, `deployments.prepare`, `deployments.deploy`, `deployments.receipts.observe` | A clean Account reaches Serving now with 0 modals beyond the review and 0 section switches, at 1440 and 390. |
| J2 | **Ship a change.** Overview "4 commits newer · Compare" → Deploy → review (newer commit waiting / already deploying → Deploy when finished) → steps → success (Open/Copy URL) → Promote. Push-to-deploy and CI reach the same receipt. | P1 → P4 → P3; Automations (P1 §5); CI (P7) | `scm.log.list`, `deployments.deploy` (whenBusy), `deployments.promote`, `workflow.trigger.add`, `account.apiTokens.create` | A busy deploy queues one latest-wins request; promote reuses the exact image. |
| J3 | **Something broke → fix it.** Attention slot (failed deploy / unhealthy / failing check / platform failure) → **Fix this deploy** or **Investigate** → composer beside → Session companion → Deploy again. Or Rollback (kept images), Restart, Logs, Run a command. | P1, P3, P11, P12, Session companion | `deployments.rollback`, `deployments.restart`, `deployments.logs.read`, `machines.services.exec`, `deployments.health.read` | One message per outage; the item stays in view beside the composer. |
| J4 | **Add a Domain.** Domains → Add → host, service/port/path, ingress, redirect, basic auth, certificate → verifying → ready / unreachable diagnosis (T2-DOMAIN-PREVIEW) / tunnel down → outside check. | P6 | `deployments.domains.add/verify/get/remove`, `deployments.bindings.set` (DNS token), machine-services `health/http` | A domain reaches Ready or one named remedy. |
| J5 | **Add a database and trust its backups.** Overview Data → Add → catalog review (on a Machine / with PgBouncer / Neon / Supabase) → preflight → created → Database page → Connect to an app → Backups: destination + Test (T2-DATA), history (T2-DATA), missed notice (T2-DATA), Back up now, Verify, Restore. | P1 → P10 → P9 → P8 Backups | `deployments.templates.instantiate`, Neon `projects-provision/-link`, Supabase `connections-save`, `deployments.bindings.set`, `deployments.backups.{run,verify,inventory,restore,prune}`, backup-destinations `s3/test` | The person sees the last good backup and can restore one chosen snapshot without leaving the Environment. |
| J6 | **Preview a PR.** Env Settings → Previews (enable, placement, address pattern, data) → PR opened → PR Overview "Preview": deploying → ready + URL (T2-DOMAIN-PREVIEW) / needs approval / cleanup / removed; preview group in the rail. | P8 Previews → P15; P13 rail group | `deployments.environments.update` (previewTemplate), `deployments.teardown`, `deployments.environments.delete` after proven absence | The PR page shows the true preview state, and a URL only from the owner fact. |
| J7 | **Tear down safely.** Environment ⋯ → Stop and remove → disposition sheet (per-volume Keep/Delete, T2-DATA; named Domains) → receipt → stuck step **Retry** (= `deployments.teardown`; routed bug) → removed. | P1 menu → disposition sheet → P3 | `deployments.teardown`, `deployments.environments.delete`, `deployments.targets.unlink` | No volume is deleted without its name being confirmed; Retry resumes teardown. |

## 3. Page groups → lanes (disjoint files)
| Lane | Group (shared anatomy) | Pages | Files it owns | Pairs with |
|---|---|---|---|---|
| L-A | Environment status page | P1 Overview, P11 Logs companion, P12 Run a command; attention precedence | `DeploymentEnvironmentDetail.tsx` (Overview branch + mount lines), `deploymentPresentation.ts`, `deploymentEnvironmentNavigation.ts` (+`logs`, Session companion), `environmentNavigation.tsx`, `DeploymentDataCard.tsx` (rows only) | Lab 1 |
| L-B | Record lists and receipts | P2 History, P3 Receipt, P4 Review facts | `DeploymentReceiptDetail.tsx`, `DeploymentStepLogs.tsx`, `DeploymentStepStrip.tsx`, `components/approvals/DeploymentReviewApprovalFacts.tsx`, History branch | T2-RECEIPT |
| L-C | Environment editors | P5 Variables, P6 Domains, P7 Permissions | `DeploymentVariablesPanel.tsx`, `DeploymentDomainsPanel.tsx`, `DeploymentDomainRow.tsx`, `DeploymentDomainIngressFields.tsx`, `DeploymentPermissionsPanel.tsx` | T2-DOMAIN-PREVIEW (domain facts) |
| L-D | Environment configuration | P8 Settings sections, incl. Previews template | `DeploymentEnvironmentSettingsPanel.tsx`, `DeploymentBackupControls.tsx`, `DeploymentRetentionChoice.tsx` | T2-DATA (backups), T2-DOMAIN-PREVIEW (template) |
| L-E | Data | P9 Database page, P10 Add service/database review, restore | new `DeploymentDatabasePage.tsx` (only new file; a page, not a primitive), `DeploymentRestoreSheet.tsx`, `useCatalogAppPreparation.ts`, `deploymentRestore.ts` | T2-DATA |
| L-F | Project level | P13 list/draft/duplicate, P14 defaults | `ProjectDeploymentsBody.tsx`, `DeploymentEnvironmentCollection.tsx`, `DeploymentEnvironmentDraft.tsx`, `EnvironmentMachineChoice.tsx`, `ProjectDeploymentDefaultsSettings.tsx`, `AllDeploymentsScreen.tsx` (loading only) | — |
| L-G | PR preview (plugin) | P15 | `packages/plugins/scm-github/src/ui/renderSurface.tsx#OverviewPanel` + one new presenter file beside it | T2-DOMAIN-PREVIEW |

## 4. Page specs
Notation: **C→A** = control → Action. **A→C** = an Action the person needs → its control. `(T2-x)` = renders when that lane's fact lands. `(§7)` = no producer; render nothing for it.

### P1 Environment Overview (L-A)
- **Entry and place:** Project → Deployments rail row, All deployments row, or an Inbox/notice deep link (`deploymentTab=overview`). A page, in place.
- **Header:** `PageHeaderMarkIcon` hard-drives · name · Production `StatusPill` (existing) · meta: Machine · status word. Healthy says "Serving" quietly; amber "Needs you"; rose "Failed"; quiet "Nothing deployed". **Primary: Deploy.** ⋯: Duplicate, History, Settings, then **Stop and remove** last (existing `EnvironmentMenu`).
- **Sections, in order:**
  0. **Attention slot** (R3): one notice, in this precedence:
     1. Machine offline (`SurfaceFreshnessLine`);
     2. no target (Link a machine / Use a platform, existing);
     3. latest deploy failed: **Fix this deploy** (`AgentActionButton`) + Open receipt;
     4. waiting for approval: Review (T2-RECEIPT);
     5. already deploying: Open receipt + **Deploy when finished** (`deployments.deploy` whenBusy);
     6. unhealthy service or failing check: **Investigate**;
     7. secret withdrawn: **Stop now** (`machines.services.control`), with a toast offering Start again; after that, the stopped state with the disabled-redeploy reason;
     8. missed backup: Back up now + Investigate (T2-DATA);
     9. platform background deploy failed: **Investigate** + build-log link;
     10. running unverified (existing);
     11. newer commit waiting: "Deploys after the current one", latest wins;
     12. catalog update available: **Update with an agent** (no apply Action, §7).
  1. **Serving now** (existing hero): commit, facts line, `DeploymentStepStrip`, `FactStrip`, plus a trailing fact row "4 commits newer · Compare" (`scm.log.list` revisionRange). A final **Definition** row: "acme/shop · compose.yaml" (opens the file in Project Code), or "Stored in Happier · revision 4, not deployed" (opens the definition editor, pushed in place; Save = `deployments.environments.update`). A `needs_repository` refusal is one line naming what it needs; Move to a repository is §7. When nothing is deployed: the existing "Nothing deployed", plus **Set it up** (`AgentActionButton`) only when the repository has no Compose.
  2. **Servers**, only when there is more than one member:
     - one `Item` per member: name, version, health glyph;
     - only a behind or degraded row carries a sentence, and "k of n down" goes in the section description;
     - a joining row says "Joining · not counted as down";
     - the section action **Manage** → Settings › Servers & build.
  3. **Services** (existing):
     - row subtitle = image or "Built here", plus "3 replicas, all receiving traffic"; only an abnormal replica gets its own sentence;
     - row ⋯: **Logs** (opens the `logs` companion), **Restart** (`deployments.restart`), **Run a command…** (P12), Open on Machine;
     - a catalog app's generated login is a sub-row "Admin login" in `SharedSavedSecretValueItem` (Reveal/Copy = `secrets.shared.reveal`; the lab's Copy-once is superseded).
  4. **Data:** one row per database: engine mark, name, where (vps-2 / Neon / Supabase), and the last backup as a fact (amber when missed or failed). Press → P9. Action **Add** → P10, filtered to databases.
  5. **Automations:** the existing `SubjectTriggersSection`. Rows for Deploy on push, Scheduled jobs and other triggers, each with last run and a late fact. **Add** offers starters (deploy-on-push with Automatic/Ask consent, app-cron Name/Service/Command/schedule) through `workflow.trigger.add`.
  6. **Recent** (existing) → History.
  - No Checks card here. Checks are configured in Settings, and their failures reach the attention slot and the service glyphs.
- **States:**
  - **Loading:** `PageLoadingRows` with header until `deployments.environments.get` settles; the serving hero reserves its row shape.
  - **Empty:** "Nothing deployed", with Deploy or Set it up.
  - **Failed:** an Environment read error is one `SurfaceStateCard` with Retry.
  - **Partial:** a serving receipt that fails to read shows a line error with Retry inside Serving now; other sections render.
- **C→A:**

  | Control | Action |
  |---|---|
  | Deploy | `deployments.deploy` |
  | Deploy when finished | `deployments.deploy` (whenBusy) |
  | Compare | `scm.log.list` |
  | Restart | `deployments.restart` |
  | Logs | `deployments.logs.read` |
  | Run a command | `machines.services.exec` |
  | Stop now / Start again | `machines.services.control` |
  | Reveal | `secrets.shared.reveal` |
  | Add automation | `workflow.trigger.add` |
  | Definition Save | `deployments.environments.update` |
  | Link a machine | `deployments.targets.link` |
  | Agent buttons | shared launcher (`deployments.prepare` for Set it up) |
  | Stop and remove | P1 menu → disposition sheet |

  The reads are `deployments.environments.get`, `deployments.receipts.list/get/observe`, `deployments.health.current`, `deployments.drift.read` (the "not deployed" revision fact) and `deployments.observation.get`.
- **A→C:**
  - `deployments.restart` and `machines.services.exec` have no control today; these specs add them.
  - `deployments.health.read` has no control yet: it backs the **Investigate** prompt context and is read in the Logs companion's health line.
- **Phone:** Deploy goes in `PagePinnedBar`. The attention banner's action wraps under its text. `FactStrip` wraps 2×2. Service rows show title + glyph, with facts beneath and ⋯ kept. Agent buttons use `compact`.
- **Scenes:** `review/waiting(p)`, `review/inprogress`, `review/compare`, `servers/overview(p)`, `servers/behind`, `servers/degraded(p)`, `servers/joining(p)`, `review/replicasRow`, `d6d/stop`, `d6d/stopped`, `d6p/stop`, `catalog/overview(p)`, `catalog/reveal*`, `d7d/added`, `d4d/cf`, `platform/alertson`, `prepare/ask(p)`, `stored/overview(p)`, `stored/needsrepo`, `stored/editor*`, `stored/saved`, `jobs/scheduled(p)`, `jobs/add`, `push/setup*`, `projsettings/triggers` (P13).

### P2 History (L-B)
- **Place:** History tab.
- **Anatomy:** no section title (existing); `CollectionToolbar` search with a funnel → tokens for state, started by and operation (T2-RECEIPT server filters), then `DeploymentReceiptRow` rows, then the existing paging.
- **States:** loading rows; empty "No deploys yet"; filtered-empty inline "No deploys match · Clear"; read failed: one line with Retry.
- **C→A:** row → `deployments.receipts.get` (P3); filter → `deployments.receipts.list` (T2-RECEIPT).
- **Phone:** the same list, with tokens inside the search field.
- **Scenes:** `d2d/byfilter`, `d2d/filterempty` (deviation: tokens, not chips).

### P3 Receipt detail (L-B)
- **Place:** pushed in place (`deployment=`), keeping the Environment bar.
- **Header:** commit subject · status word (Deploying / Live / Failed / Waiting for approval / Cancelled) · meta (who, when, Machines).
- **Attention slot:**
  - Failed: rose, **Fix this deploy** (`AgentActionButton`), secondary Rollback when a kept image exists.
  - Waiting for approval: the shared approval card inline, Approve/Deny (T2-RECEIPT).
  - Cancel after a stop: the phase-aware ask (T2-RECEIPT).
  - Release cleaned up: "Deploy again" (a variant of rollback).
- **Sections:** Outcome (`OperationsOutcomeGroup`; success URL Open/Copy) → Facts → **Images** (tags, config digests, build times, from receipt content) → Steps (`DeploymentStepStrip` + `DeploymentStepLogs` per step) → Log.
- **Pinned bar primary by state:**
  - running → Cancel;
  - failed with a kept image → Rollback;
  - teardown with a stuck step → **Retry = `deployments.teardown`** (fixes the bug where it called deploy);
  - otherwise → Deploy again.
  - Promote sits in ⋯.
- **States:** loading `PageLoadingRows`; read failed: one card with Retry.
- **C→A:**

  | Control | Action |
  |---|---|
  | Cancel | `deployments.cancel` |
  | Rollback | `deployments.rollback` (`DeploymentPromotionSheet`/rollback review) |
  | Promote | `deployments.promote` (rebuild offered only when the exact image is unavailable: plan rule, lab redrawn) |
  | Deploy again | `deployments.deploy` |
  | Retry | `deployments.teardown` |
  | Logs | `deployments.logs.read` |
  | Fix | shared launcher |

- **Phone:** the pinned bar keeps one primary, with the others in ⋯. Images rows put digests beneath, in mono.
- **Scenes:** `rollback/image(p)`, `rollback/pruned`, `teardown/stuck`, `d3d/waiting`, `d3d/cancelask` (T2).

### P4 Deploy / promote / rollback review facts (L-B)
- **Place:** shared `ApprovalDetailScreen`/inbox card. Only `DeploymentReviewApprovalFacts.tsx` changes.
- **Fact order:**
  1. What (commit, images);
  2. Where (servers; a mixed-architecture warning is §7);
  3. Change (newer than serving, commit count);
  4. Blocking issues (missing required secret, T2-RECEIPT: non-deployable branch with an Open Variables action);
  5. Rollout choice "If a server fails: Roll all back | Keep partial", shown read-only as captured (T2-RECEIPT). Amended per O-DEPLOY RULING 13:34: the person picks it before `deployments.deploy` is requested (P1 Deploy control, L-A); signed input stays immutable, so changing it means cancel and request again;
  6. Waiting newer commit (latest wins).
- **Phone:** facts stack; Approve is pinned.
- **Scenes:** `review/promoteBuild` (redrawn to the plan rule), `rolling/review*`, `d3d/missing` (T2).

### P5 Variables (L-C)
- **Anatomy:** existing panel.
  - The + menu offers Value, Saved Secret, and **Point at another service** (service picker; `deployments.bindings.set` reference source).
  - A pending agent request for a secret renders inline at the top as the shared input card (`ApprovalInboxCard` + the existing secure chooser), not a Variables-specific card.
  - Row states: withdrawn (amber, "Stop now" lives in the Overview attention slot), **Address changed · redeploy to apply** (T2-DOMAIN-PREVIEW fact) + Deploy.
- **C→A:** add/edit/point → `deployments.bindings.set`; Deploy → `deployments.deploy`.
- **§7:** Compose interpolation check (`variables/check`), rotated secret still running (`d6d/rotated`).
- **Phone:** rows stack value beneath name; the + menu stays in the section header.
- **Scenes:** `variables/add`, `variables/refpick`, `variables/agentask(p)`, `variables/changed`, `variables/rowsp` (T2).

### P6 Domains (L-C)
- **Anatomy:** section description = the Machine's ingress posture ("Closed to the internet: use a Tunnel or Tailscale"). Rows are `DeploymentDomainRow` with these states:
  - verifying;
  - ready;
  - unreachable from outside, with one diagnosis and remedy (T2-DOMAIN-PREVIEW);
  - certificate expires soon (T2-DOMAIN-PREVIEW);
  - tunnel disconnected → Reconnect. Reconnect re-runs the same tunnel preparation the add form uses; L-C verifies the operand, and if it is not re-entrant, lists it under §7.
- **Row expansion** (`ExpandableItem`): service/port/path, ingress, redirect, basic auth, and **Check from outside**, which takes an alert-after-N-failures threshold (machine-services `health/http`, vantage outside), then Remove.
- **Add** (the existing add modal, extended):
  - Host; Service · Port · Path;
  - **Ingress** as a bordered field select, because the labels are long (deviation from the lab's four tiles): Caddy on this Machine / Cloudflare Tunnel / Tailscale / Closed;
  - Redirect alias;
  - Basic auth (`presentSavedSecretReferencePicker`);
  - Certificate: Automatic | Your certificate (segmented);
  - a wildcard host adds a "Needs a DNS token" row with the Saved Secret picker (`deployments.bindings.set` domainCredential).
- **C→A:**

  | Control | Action |
  |---|---|
  | Add | `deployments.domains.add` |
  | Verify | `deployments.domains.verify` |
  | Reconnect | the add form's tunnel preparation; L-C verifies the operand, else §7 |
  | Remove | `deployments.domains.remove` |
  | Expand | `deployments.domains.get` |
  | Outside check | machine-services `health/http` |
  | DNS token | `deployments.bindings.set` |

- **§7:** Docker Desktop domains unavailable (`domains/dockerDesktop`).
- **Phone:** fields stack under their labels.
- **Scenes:** `domains/add(p)`, `domains/wildcard`, `domains/outside(p)`, `d2d/adddomain`, `d2d/closed`, `d2d/domains`, `d2d/tunneldown`, `d2p/domains`; T2: `domains/unreachable`, `domains/routingp`, `domains/cert`.

### P7 Permissions (L-C)
- **Sections:**
  1. **Who may deploy**: Everyone with access | Chosen people (segmented), with a people picker → `deployments.environments.update` deployerMode/Principals.
  2. **Approvals**: one row per operation, Default | Ask | Allow (segmented) → `actions.policy.set`. When approvals are changeable by the deployers themselves, the section description says so (no banner).
  3. **Deploy from CI**: when not set up, the row "Create a token for this Environment" → `account.apiTokens.create` (Environment-scoped grant). On creation, the token is shown once, masked, with Copy, plus a CI step code block and the fact "Production still asks". Existing tokens link to the Account API tokens page; no second token list.
  4. **Controller** (existing link).
- **Phone:** segmented controls move beneath their labels.
- **Scenes:** `d2p/access`, `d2d/chosen`, `d2d/selfloose`, `ci/box`, `ci/setup`, `ci/created(p)`, `ci/on`.

### P8 Settings sections (L-D)
One page with six anchored sections (canonical ids). The Account defaults link stays at the top (existing).
- **Servers & build:**
  - Runs on (link/unlink, existing);
  - **Servers** (members; **Add a server** → `DeploymentLinkMachineSheet` with replacesLinkId → a joining row; removing a member is §7, so there is no Remove);
  - **Builds on** (field select; the emulation refusal is §7);
  - **Ingress for several servers** (field select: Cloudflare Tunnel (recommended) / Front server, with "single point of failure" as its description; the no-private-network and no-zone variants are row descriptions plus a preselection);
  - **How it deploys** (read-only fact rows: build placement, image distribution, traffic).
  - Actions: `deployments.targets.link/unlink`, `deployments.environments.update`.
- **Controller:** existing (`deployments.environments.controller.set`). The paused fact is §7.
- **Rollout:** existing rows for rollout, auto-restore and kept-for-rollback, editable → `deployments.environments.update`.
- **Checks & alerts:**
  - a **Checks** list, one navigation row per check, with kind icon, target and last result (late heartbeat = amber);
  - **Add check** → machine-services `health/open-setup` (its plugin renderer; five kinds; threshold; heartbeat ping URL with Copy);
  - the existing alerts row.
- **Backups:**
  - existing: destination, sources, keeps, status, restore entry;
  - added: **Test destination** (backup-destinations `s3/test`, T2-DATA, replacing the stub), **History** rows (T2-DATA), **Remove old backups now** (`deployments.backups.prune`, existing Action with no control);
  - missed-backup state (T2-DATA);
  - §7: the local destination and the retention-count writer.
- **Previews:** the template editor on the same Environment:
  - Enable (switch);
  - Runs on (field select);
  - Address pattern (`pr-{number}.…`);
  - **Data**: Its own | Neon branch | None (segmented; managed parent branch picker);
  - Production Machine (a warning in the description);
  - Close/merge cleanup is automatic under P44. Failed or denied cleanup exposes per-preview Clean up / Retry cleanup in PR Overview through existing teardown/delete; no bulk Settings control (O-DEPLOY 2026-11-07 added-scope ruling, T2-DOMAIN-PREVIEW P44 determination).
  - Fork previews: one fact row "Pull requests from forks don't get previews" with no control (approve-each-commit is §7).
  - All writes → `deployments.environments.update` (previewTemplate).
- **States:** each section reserves its rows; a section read failure is one line with Retry.
- **Phone:** the section list stacks; anchors become the Settings landing list (existing).
- **Scenes:** `servers/add(p)`, `servers/ingress*`, `servers/how`, `review/howitdeploys`, `checks/*`, `controller/*` (existing), `d5d/template`, `d5d/domains`, `d5d/prodmachine`, `previewdb/template`, `previewdb/branch`; T2: `d7d/destfail`, `database/backups(p)`.

### P9 Database page (L-E, the only new page file)
- **Entry and place:** a P1 Data row, pushed in place inside the Environment. It reuses the receipt's pattern: one more destination param (`deploymentService=`) added at the existing destination owner (`deploymentNavigation.ts`), not a new router. It keeps the Environment bar.
- **Header:** engine identity mark (no tile) · name · status word (quiet Healthy, amber Backup missed, rose Backup failed) · meta: where (vps-2 · internal | Neon · eu-central). **Primary: Connect to an app.**
- **Sections:**
  1. **Connection:** Internal / Private / Public address rows. Public carries an amber exposure fact. Connection strings use `SharedSavedSecretValueItem` (Reveal/Copy); a pooled + direct pair appears for PgBouncer and Supabase.
  2. **Used by:** reference bindings → Variables.
  3. **Backups:**
     - last good backup, schedule, and a destination row → Settings › Backups;
     - History (T2-DATA);
     - Back up now; Verify latest;
     - **Restore…** opens `DeploymentRestoreSheet` with a snapshot picker over `deployments.backups.inventory`. Restoring shows its single outcome; step progress is §7.
  4. **Provider** (managed only): identity, region, "Open in Neon/Supabase".
- **Attention slot:** missed backup (T2-DATA) → Back up now + Investigate.
- **C→A:**

  | Control | Action |
  |---|---|
  | Connect to an app | `deployments.bindings.set` (destination Environment/service and exported names) |
  | Back up now | `deployments.backups.run` |
  | Verify latest | `deployments.backups.verify` |
  | Restore | `deployments.backups.restore` |
  | Reveal | `secrets.shared.reveal` |
  | Connect Supabase | `happier.deploy.supabase` `connections-save` |

- **§7:** Query, Console, Import a dump, Restore drill.
- **States:** loading rows; database gone: one message with Back to Overview.
- **Phone:** Connect to an app in `PagePinnedBar`; address values move under their labels.
- **Scenes:** `database/selfhosted(p)`, `database/managed`, `database/public`, `database/connect`, `database/connectManaged(p)`, `d7d/restore1`, `d7p/restore`, `d7d/data`, `d7p/data`; T2: `database/missed(p)`, `database/backups(p)`, `database/destination`.

### P10 Add a service or database (L-E)
- **Entry:** P1 Services **Add** and Data **Add** (database filter). It is a sheet over the Environment (`deploymentSheet.ts`), in place, and never routes to Store.
- **Anatomy:**
  1. **Choose:** the existing catalog list component used by Store (L-E names it on reuse; it must not fork it), with search.
  2. **Review**, in the same sheet: template, where (this Environment's Machine), options (volume; **PgBouncer** with the paired DATABASE_URL/DIRECT_URL fact; connect to a service).
  3. **Preflight:** checking → OK, or "Short on memory" (approvable warning); port in use is §7.
  4. **First run:** a card, "Create your admin now" with Open.
  - Managed choices: Neon (`projects-provision` + `projects-link`), Supabase (`connections-save`).
  - Primary: **Add**. The result is the new row in Services/Data, a login sub-row and, for repository-backed Environments, "Pull request opened".
- **C→A:** Add → `deployments.templates.instantiate` (existing environmentId); managed → plugin actions above.
- **Phone:** the sheet is full height, with Review pushed after Choose.
- **Scenes:** `d7d/catalog`, `d7d/checking`, `d7d/capacity`, `database/create`, `database/createPooler`, `database/createmanaged`, `catalog/firstRun(p)`, `d7d/added`.

### P11 Logs companion (L-A)
- **Place:** a desktop companion beside the current Environment page (Plan T `companion`); on phone a pushed page with the Environment bar. Opened from a service row's Logs and a receipt step's Logs.
- **Anatomy:** pane header with a service field select + Build | Runtime (segmented), then the log body: the same viewer as `DeploymentStepLogs`, with a live tail through `deployments.logs.read` tail.
- **States:** loading rows; "No logs yet"; read failed: one line with Retry; `secret_redaction_unavailable` gets its owner's message.
- **Scenes:** `d1d/logs`.

### P12 Run a command (L-A)
- **Place:** service row ⋯ → modal (`Modal` + `ModalCardFooterActions`).
- **Anatomy:** Service (prefilled) · Command (mono field) · **Run** → output (`AnsiText`) + an exit-code fact · Run again.
- **C→A:** `machines.services.exec`. A scheduled version is the Automations app-cron starter (P1 §5).
- **Scenes:** `jobs/run`, `jobs/output`.

### P13 Project → Deployments list, draft, duplicate (L-F)
- **Anatomy:**
  - Existing list-detail. Rail rows get the needs-you highlight (`CollectionRowNeedsYouHighlight`) and a **preview group** under each template: the first 5, then "Show N more".
  - **+** goes straight to a draft at the top (NIP `d1d/addmenu` deleted).
  - In the draft, a Machine that is not ready shows the Machine setup review card in place (`machines.setup.apply` through the shared approval presenter; the approved-running and Plan-again transitions are P20.4b's VAR).
  - **Duplicate:** the draft with copyFrom. Each secret row offers Reuse | Choose another (Saved Secret picker); **Data** offers Reuse | Start empty | Restore latest backup (segmented).
  - **Project settings** (link-only): defaults, preview-template links to each template's Settings › Previews, and repository triggers (`SubjectTriggersSection` with the project subject).
- **C→A:**

  | Control | Action |
  |---|---|
  | Create / Duplicate | `deployments.environments.create` |
  | Machine setup | `machines.setup.apply` |
  | Triggers | `workflow.trigger.add/remove` |

- **Phone:** the list pushes the Environment detail.
- **Scenes:** `d1d/notready`, `duplicate/choose(p)`, `projsettings/triggers`, `approvals/states`.

### P14 Account and Project defaults (L-F)
- Existing `DeploymentsSettingsView` / `ProjectDeploymentDefaultsSettings`: build Machine, controller Machine, kept-for-rollback (`projects.deploymentDefaults.set`).
- The five owner links stay as links.
- §7: preview Machine/database and backup destination/schedule/retention defaults.

### P15 PR Overview preview section (L-G, plugin)
- **Place:** an Overview section beneath the PR facts in `scm-github/src/ui/renderSurface.tsx#OverviewPanel` (P44 §6). It is not a tab. It uses plugin-ui components only (`Item`/rows, `RowStatusLine`, `StatusPill`, `AgentActionButton`).
- **Anatomy:** a "Preview" row: status glyph + one state sentence. Facts: serving SHA vs PR head, URL Open/Copy only from the T2-DOMAIN-PREVIEW ready/URL fact, and its own database (ready/creating).
- **Actions by state:**

  | State | Next action |
  |---|---|
  | Needs approval | Review (approval card) |
  | Deploying | progress fact |
  | Failed | **Fix this deploy** + Open in Happier (receipt) |
  | Closed, not removed | **Clean up** (`deployments.teardown`) |
  | Removed after merge | History link |

- **§7:** fork states. Reading "the preview for this PR" needs a per-PR projection, because `deployments.environments.list` filters only by project/Machine/ids; see §7 item 1.
- **Phone:** the row's facts move beneath; actions stack.
- **Scenes:** `d5d/pr`, `d5p/ready`, `d5d/deploying`, `d5d/need`, `d5p/need`, `d5d/gone`, `d5p/gone`, `d5d/cleanup`.

## 5. Labs
- **Lab 1, Overview with several servers** (L-A builds A while the lab runs; the lab decides before L-A's whole-page acceptance). Real heavy data: 3 servers, one behind and one joining, 6 services, 2 databases, 3 automations, at 1440/390, light and dark.
  - **A (recommended):** separate Servers and Services sections, as specified.
  - **B:** one "Running" section with each server as a sub-heading and its services beneath (only when there is more than one server).
- No other page needs a lab. Domain ingress, Database page placement and the Logs companion are decided above.

## 6. Two-way parity: deployments Actions with no control today
| Action | Control after this spec |
|---|---|
| `deployments.restart` | P1 service row ⋯ Restart |
| `deployments.backups.prune` | P8 Backups "Remove old backups now" |
| `deployments.previews.cleanup` | P8 Previews "Clean up closed previews" |
| `deployments.health.read` | read behind Investigate and the Logs companion health line |
| `machines.services.exec` | P12 |
| `scm.log.list` (revisionRange) | P1 Compare |
| `account.apiTokens.create` (Environment grant) | P7 Deploy from CI |
| `secrets.shared.reveal` | P1 login sub-row, P9 connection |
| `deployments.publish`, `deployments.publish.prepare`, `deployments.preparePublishCatalog` | N/A here: Plan 60 publish/starters surfaces, not an Environment page |

## 7. Missing facts (no page designs around them). O-DEPLOY to tier them; the owner records anything that stays out of 0.3 as "after 0.3".
**Proposed as Tier 2, because they touch a core journey or data safety:**
1. **Per-PR preview projection** (Environment + serving SHA + state + URL for one PR), so the PR card makes one read instead of listing Environments and matching provenance. It belongs with T2-DOMAIN-PREVIEW's ready/URL fact. (J6)
2. **Controller paused fact:** jobs and alerts are silently paused while the controller Machine is offline (`controller/paused`). (J3)
3. **Running vs saved secret revision:** a rotated secret is still running (`d6d/rotated`). (security, J3)
4. **Backup retention-count writer** (`database/keep`). (J5 trust)
5. **Restore step progress** (`d7d/restoring`). (J5: during a restore the person can't see it running)

**Proposed as Tier 3:**
- drain/remove a server member, stateful-service refusal, build emulation refusal, per-platform builds;
- definition revision history; Move to a repository; Move Machine;
- Compose interpolation check; Docker Desktop domain capability;
- registry update apply (the notice ships with **Update with an agent** only);
- P43 provider sync/list/runtime logs/row menus/link recovery/token probe;
- fork exact-head approval; preview reset to seed;
- local backup destination, port-conflict preflight, import dump, query, console, restore drill;
- prepare PR/file-list result; preview/backup Account defaults.
