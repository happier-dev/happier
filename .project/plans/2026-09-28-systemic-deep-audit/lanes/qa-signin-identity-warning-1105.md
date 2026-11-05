DONE

Helper fixes committed: `e12ac8f19a7f8d49b9e59c65b67021a44e256ab9`. Focused 10, adjacent 8, entry-load graphs 7 passed.
Loaded CLI replay passed after READY70 (live-final.json); first run returned account_unavailable despite later HTTP200, retained in live.json. This failure did not reproduce on Account reload or full replay; cause remains unproven.

Observed Home identity and address
- `agent-qa-l12-main` owns nldw3:9446, server on nl3:10306; Lane 12 Main owns this QA stack.
- Its retained remote env pins HAPPIER_PUBLIC_SERVER_URL and HAPPIER_CANONICAL_SERVER_URL to `https://nldw3-5-36-33.tailfce179.ts.net:9446`.
- Providers ORCH's `agent-qa-providers` pins both to `http://happier-agent-qa-providers.localhost:3101`.
- Loaded /v1/features on those endpoints and `https://leeroy-mbp.tailfce179.ts.net:8443` advertised each endpoint's own URL and the same stable Home identity.
- Read-only shared PostgreSQL: HomeSettings/home revision48 has neither canonical nor public URL; SimpleCache/server.identity.v1 has the stable identity, not an address.
- DB identity writer: `apps/server/sources/app/serverIdentity/serverIdentity.ts#getOrCreateServerIdentityId` creates/pins identity at server initialization. Which historical host first wrote it is unproven.
- URL owner: `apps/server/sources/app/serverUrls/effectiveServerUrls.ts#resolveConfiguredCanonicalServerUrl`; configured canonical URL, then deployment-public fallback.
- Stack remote command construction forwards originCanonicalServerUrl/stablePublicServerUrl in `apps/stack/scripts/utils/dev_targets/remote_commands.mjs`.
- Each same-DB QA replica should advertise its own configured reachable URL above. No shared identity-record correction is indicated.

Observed browser cause and timing
- QA-K-58C's empty-field page held a saved Mac-address profile with that shared identity and no canonicalServerUrl metadata.
- `connectHomeAtAddress.ts:120` compares the saved address with the reached Home; `homeConnectPresentation.ts:13` displays that previous address in normal confirmation.
- The warning precedes restore, consistent with Account A also failing: it is not Account-specific or a claim that this server advertises Mac.
- Browser profile storage owner: `serverProfiles.ts` seeds configured endpoints, persists upserts, and attaches learned identities. This browser's first writer is unproven.
- Env modification predates failures (2026-11-04 20:43Z); current UI adds saved-address confirmation. Derived: newly loaded UI explains the regression; activation at Expo 00:52Z remains unproven.
- Evidence: `.project/tmp/qa-signin-identity-warning-1105/diagnosis.json`; QA-K-58C evidence; Providers `route-signin-helper.md`; board 08:49Z/08:51Z.

Change and verification
- Explicit `--confirm-home-alias=PREVIOUS_HOME_URL` accepts only a dialog naming that prior address and this Stack's canonical URL, through the normal confirmation button. Otherwise returns home_alias_confirmation_required before fill.
- The browser adapter observes mounted settings-account-identity; Account prefix comes from that main-frame navigation's loaded Home profile, not an optional account-id row or credential storage.
- No exported owner identity test-id constant was found in the Account route/settings owner; no UI source change was needed.
- Removed the old row/child-index dependency and internal Stack-info test mock; endpoint discovery stays with Stack-info, browser operations with qa_browser_signin_page.mjs.
- Constructed RED: `red-mac-host.log` (4/4 fail: stale row, alias); `red-profile-source.log` (4 profile failures); `red-alias-consent.log` (current-address consent must not authorize another alias).
- GREEN: `green-current.log` (10/10), `green-adjacent.log` (8/8), `entry-loads.log` (7/7 graphs); all under `.project/tmp/qa-signin-identity-warning-1105/`.
- Commands: hstack-exec --target=mac-host -- node --test (focused file; adjacent browser-signin/CDP pattern); hstack-exec --target=mac-host -- pnpm check:entry-loads. Loaded actual CLI: stdin restore → Account header/profile → Home sidebar; exit0, credential output false, final fields empty.
- Mandatory finalizer passed (zero changed TS roots); private-index commit uses current machine identity. Foreign staging/worktree hunks preserved; no push.
- Mechanisms: contract checks +3/−1 (alias pair, mounted header replacing old row, Home/main-navigation profile correlation); error codes +1/−0; persistent states/timers/retries +0/−0; source/test files +2/−0.
- ID validation moved from row text to profile; temporary DOM/CDP observation remains event-driven, with one profile-body read and no extra server fetch. CLI help documents consent; no product documentation change.

Residual risk and next action
- Observed READY70 server selected=loaded b60c10761b4f161a; daemon selected=loaded 93576e924a9e757e. Default daemon PID1871849 survived before/after. Owned browser worker PID2066504 was retired after replay; no stack lifecycle changed.
- QA-K-58C/Providers ORCH: after your stack is READY, add --confirm-home-alias=https://leeroy-mbp.tailfce179.ts.net:8443 for the verified saved Mac alias, then rerun; unexpected addresses require investigation.
- Residual: first account_unavailable has no causal trace and remains unexplained; do not infer a transport defect from it. Replay trace proves GET200 from this main document and excludes preflight. First browser-profile writer, historical DB creator and exact UI activation remain unproven. No Account settings/shared identity/DB changed.
