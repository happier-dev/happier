ACCEPTED_WITH_FIXES
Commit: pending (see "Commit" below). Pairs: `.project/tmp/PREVIEW-DB-1110/opus/` (`before-*` / `after-*`).

## What was judged

- **Surface:** Environment → Settings → Previews, template editor (the "Data" choice, the new "Branched from" parent row, and the saved-enrollment warning). I looked at the whole Settings page in its real shell at wide light, wide dark, and 390 light and dark.
- **Reference:** lab `servers-deploy/deployments/shots/previewdb-branch-{light,dark}.png` (`previewdb/branch`).
- **How it was rendered:** No QA Account Environment has a preview template with a linked Neon or Supabase database. The live stack cannot reach these states without a provider tenant. I extended the existing dev specimen (`/dev/deployments?preview=unset|linked|enrollment`) and drove the real page from it. The specimen uses the real signed-in Account's deployment-target declarations, so the real Neon plugin's branch contribution is used, and Staging is seeded as an `acme/shop` template with a linked Neon `main`. Only the branch-list answer and the update outcome come from fixtures.

## Differences

| # | Difference (before → after) | Class | Evidence |
|---|---|---|---|
| 1 | "A branch of the database" could never be chosen. Every option carried `unavailableReason`, and the shared segmented row rule treats any reason as disabled, so the lane's feature was unreachable in the rendered page. The lane test only asserted the option prop. Now only an unavailable option carries a reason. RED → GREEN with a press on the rendered segment. | defect fixed | `before-unset-light.png` / `after-unset-light.png`; `segment-red.log`, `segment-green.log` |
| 2 | The parent row was titled "A branch of the database", repeating the segment beside it, and it had no description. It is now "Branched from", with the outcome: "Each pull request gets a branch with no data copied, deleted when the pull request closes". This also covers the lab's separate "When the pull request closes" row. | defect fixed | `before-linked-light.png` / `after-linked-light.png` |
| 3 | The value was shown twice ("Neon · main" beside a field that said "Neon"), and the row subtitle showed raw provider ids (`polished-sun-… · br-main-…`). Now the field alone holds "Neon · main", through `DropdownMenu` `detailFormatter`, and `showSelectedSubtitle: false` removes the ids. | defect fixed | same pair |
| 4 | While a parent was read, a "Loading…" line was inserted under the row and then removed, so the page jumped twice. Loading now shows in the field, which is held disabled, so nothing moves. | defect fixed | `before-reading-light.png` / `after-reading-light.png` |
| 5 | The Data row said "Not set up for this environment · ask an agent to set it up" when only "Its own database" was unavailable. It read as if Data as a whole was unavailable. A single unavailable option now names itself ("Its own database is set up by an agent" / "Branching needs a linked database that supports it"). The shared sentence stays for the case where both options are unavailable. | defect fixed | `after-unset-light.png` |
| 6 | The enrollment warning was a full-size centred state card at the top of Settings, out of view of a person saving at Previews. It also contradicted itself: "Saved · …needs attention" above the generic "Happier could not complete this change". It now sits inside Previews as one `size="line"` warning, "Saved, but new pull requests won't get previews yet". The remedy is shown only when the recovery owner has a specific one (`readDeploymentRefusalRecoveryV1`), and the Details disclosure keeps the code. | defect fixed | `before-enrollment-light.png` / `after-enrollment-light.png`, `after-enrollment-dark.png` |
| 7 | The lab uses a separate "Database for each preview" section with provider-named segments ("A Neon branch"). Live keeps one Previews sheet with generic segment labels. | accepted refinement: one Previews composition from earlier lanes; generic labels avoid a hand-copied provider list | lab vs `after-linked-light.png` |
| 8 | The lab names the branch pattern (`preview/pr-{number}`) and a production-data access note. Live says no data is copied, which is truthful for Neon `parent-schema` and Supabase `with_data:false`. | lab outdated | — |
| 9 | 390: Data becomes the shared select, and "Branched from" moves its field under the label. Dark mode keeps ink edges and the warning tint. | matches doctrine | `after-enrollment-390-{light,dark}.png` |

## Checks

| Check | Verdict | Evidence |
|---|---|---|
| RED: rendered Branch segment opens the picker | RED for the intended reason (picker stayed null after the press) | `segment-red.log` |
| GREEN: Tabs previews slice | 16/16 | `segment-green.log` |
| Focused UI files (local; the AUTO run died with its windows2 worker after 2 h in the queue) | BranchChoice 1/1, the lane's Tabs branch case passes, outcome/branches files pass. 5 other Tabs Settings cases fail, all unattributed. They exercise concurrent uncommitted work: Configure Previews runtime/address/domain (PREVIEW-FLOW), backup schema `safeParse` and backup setup (BACKUP-SUITE / DATA-SERVICES). None of them touches the Data choice, the parent row or the enrollment line | `ui-green.log` |
| entry-loads | 11/13 passed. `daemon` (zod `.omit()` on refined backup configuration in the foreign `deploymentPreviewTemplateV1.ts` copyFrom/destinationBackup hunk) and `server` (missing source export `deploymentDataQueryV1`) are unattributed and outside UI | `entry-loads.log` |
| Live render light / dark / 390 | done | pairs above |

## Remaining issues (not fixed here)

- A saved parent shows only "Neon" after a reload or remount. The parent's branch name is not stored on the template, so only a fresh read shows "Neon · main".
- If the parent is not on the first branch page, the "Next" card is still titled "A branch of the database". Following the cursor automatically would remove that state.
- Menu items still show raw provider ids, because a linked database has no display name.
- Whole-page items that predate this lane: the Previews section repeats "Previews" as its first row title; on a phone, "Runs on" keeps a long machine name beside its label; "Pull requests from forks don't get previews" is a bold info row. The concurrent PREVIEW-FLOW rows ("Preview domain", "Template slug", "Preview variables") were not judged here.
- The enrollment warning is page state, so it does not survive a remount (the wide→390 switch dropped it).

## Commit

Pending.

Model trial: claude-opus-5-5 at medium effort; surface Environment Settings → Previews (preview database parent + enrollment warning); review rounds until accepted: 1 (self-accepted with fixes, awaiting the orchestrator); usage limit: hit once mid-task (resumed on O-DEPLOY's notice).
