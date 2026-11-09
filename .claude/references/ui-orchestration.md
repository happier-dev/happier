# Claude UI orchestration

Load before any rendered surface change, UI-lane brief, capture or taste review. The current 2026-10-29 override in `.claude/CLAUDE.md` wins over the suspended historical table below. Before board/coordination work, read the 2026-10-31 **Usage economy and board conventions** row in `.project/OWNER-RULINGS.md` **Process and orchestration**.

- Any lane touching user-facing surfaces, components or animations follows "Taste digest" below before writing surface code.

- **Briefs carry the UI rule; agents on other providers never read this file.** Every brief for a lane
  whose change renders anything (new state, control, copy, error or repair view), including Codex/Sol
  "behavior", fix, parity and QA lanes, names `.agents/skills/happier-ui-craft`, the reference (lab
  scene or shipped screen) and the whole-page live check. Never split a feature into a "non-visual"
  lane that ships rendered states and a later "visual" lane that dresses them; the lane that adds a
  rendered state owns its craft, or hands that state to a craft lane before it lands.

- **Design fidelity is judged per page, live, by eyes.** Audits that diff code against a lab, or lists
  of region deltas, are inputs. A UI corridor is not done until a taste lane has compared each touched
  page whole (in its real shell, real-looking data, current loaded bundle, light/dark/phone) with its
  reference and recomposed what reads wrong, and the orchestrator has viewed the key side-by-sides
  itself. A stale bundle is not evidence; get a hot-reloaded or freshly exported UI first.

- **One composition owner per surface.** Visual composition of a user-facing page, sheet or popover
  is done by one Opus UI lane per boundary, which owns that whole surface (all its states and phone
  form). Logic/data lanes (Sol) deliver hooks, props and data and do not edit that surface's layout,
  styling or render tree; when a logic fix needs a visible change, they describe it for the UI owner.
  Briefs scope UI lanes by **surface**, not by lab frame or findings list, so the page is judged as a
  whole (method: `.agents/skills/happier-ui-craft/references/validation.md` → "Building a designed page").

- **UI lanes always get a live render path.** Never brief a UI lane with live rendering forbidden or
  the stack down; if no runnable stack exists, start or fix one first, or mark the UI work blocked.
  Source QA borrows the dev stack's moving Expo by default
  (`stack start <qa> --runtime=source --restart`); an edit shows on browser reload.
  If Expo is down, server/daemon starts and reloads continue; park only UI/QA-UI until `Expo READY`.
  Stack info shows UI waiting and detects recovery without restart; never start Metro/export as fallback.
  Server and Account/stack URLs are runtime parameters, not bundle inputs. Use `--ui=export` only
  for release/boundary acceptance; unchanged inputs/options reuse the completed export.
  Source-only verification of a UI lane is not a completion state. The orchestrator itself looks at the
  rendered whole pages (not only cropped elements) next to the lab at every UI boundary.

- **Who builds and checks surfaces (user ruling 2026-10-11).** Lanes that design or change how a
  user-facing page looks run on Opus with `happier-ui-craft` loaded and a live stack to render on.
  Sol/Codex lanes may wire data, Actions and behaviour behind a surface but must not change its visual
  composition unseen; when a Sol lane's change alters a surface, an Opus fidelity pass on the whole
  page follows before the corridor closes. Design verification is page-level (whole lab scene next to
  the whole live page, every state including degraded ones), never only component crops, and the
  orchestrator looks at the full-page pairs itself before accepting.

- **Suspended while the 2026-10-29 override above stands; restore it when the owner lifts that override.**
  **Models and effort for UI work (user ruling 2026-10-11, split confirmed 2026-10-12 after the
  Sonnet trial).** Lanes without an effort setting inherit the session's effort, which drained Opus
  usage fast.

  | Work                                                                                                                  | Model and effort             | Agent definition     |
  | --------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------- |
  | Orchestration, program-boundary and ship reviews, final whole-page acceptance, new design-lab rounds                  | Opus, high                   | `design-review-opus` |
  | Shared primitives and tokens, the settings shell, pages being recomposed or newly designed, motion                    | Opus, medium                 | `ui-build-opus`      |
  | About half of UI lanes: well-specified surfaces, fix lists, state and after-pair verification, copy and locale sweeps | Sonnet 5.5, high (never max) | `ui-build-sonnet`    |
  | Logic, data, tests, tooling, functional QA                                                                            | Codex Sol, unchanged         | —                    |

  Trial result (2026-10-12): both models reached acceptance in 2–4 review rounds. Sonnet's
  specified fixes held live and found real root causes with almost no usage limits; Opus medium
  was stronger on whole-page recomposition and shared primitives at about 1 M tokens per lane.

  - **UI routing:** Sonnet high for specified fix lists and after-pair checks first; Opus medium (`ui-build-opus`) for
    composition/recomposition; Opus high only for final whole-page acceptance. Pin effort in every agent definition (agents
    without one inherit the session's effort). There is no cap on concurrent Claude lanes (owner, 2026-10-20): Happier
    rotates connected Claude accounts on usage limits. Keep the Claude/Codex routing and lean briefs above; parallelism
    is limited only by real prerequisites (a live render path, one composition owner per surface, one lifecycle owner per
    QA stack).

- **Capture vs judgement (design quality is not traded away).** Sol may _capture_ (seed data, sign in, take
  same-state whole-page lab|live pairs at the required widths/themes, record motion frames, measure computed styles)
  into a contact sheet. Only Claude UI lanes _judge and change_ how a surface looks; Sol never edits render
  composition, styling or copy hierarchy, and "Opus writes a spec, Sol builds the visuals" is not allowed. The
  orchestrator still views the decisive whole-page pairs itself.

- **Fresh, short Claude UI lanes per round.** Close a UI lane after its round (report holds the state) and start the next
  round fresh from a short brief pointing at that report; don't resume 400k+ contexts. Bound each round (≈60–120 min).

- **Never run a Claude lane on a broken prerequisite.** Launch or resume a UI lane only after the render path and the
  fixes its pages need are confirmed (stack READY + page loads with data).

- **References first.** When the owner names a reference app/look, a Sol run reads its exact recipe from source first,
  and acceptance is measured in the owner's exact setup before a Claude reviewer judges it.

- **Images:** capture broadly, view narrowly — lanes save all pairs to disk; reviewers open the 2–4 decisive ones.

- **Taste digest:** before writing surface code, lanes touching user-facing surfaces, components or animations load
  `.agents/skills/happier-ui-craft` (Happier's method, which ranks first), DESIGN.md and a one-page digest of the taste
  skills; open an installed specialist (`make-interfaces-feel-better`, `interface-details`, `design-taste-frontend`,
  `gpt-taste`, `high-end-visual-design`, `minimalist-ui`, `redesign-existing-projects`, `apple-design`,
  `emil-design-eng`, `review-animations`) only for a concrete question. Neither digest nor specialist overrides
  DESIGN.md tokens, materials, primitives or the no-fork rule: translate web/landing-page recipes (fonts, palettes,
  GSAP, bento layouts) into Happier's owners, reuse existing components, themed tokens and text primitives, and treat
  duplicate animation/UI primitives as a review finding.

