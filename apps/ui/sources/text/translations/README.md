# Locale files

One file per language, named for its code: `fr.ts`, `ja.ts`, `zh-Hant.ts`. `en.ts` is the source of
truth — it holds the English AND defines the shape every other locale must match.

A locale file is TypeScript, not data. Values are either strings or **functions** whose parameters
are typechecked and whose bodies interpolate `${...}`. `i18n.integrity.test.ts` requires every
locale to have identical key structure to `en.ts`, and requires sampled functions to still be
functions. That is why nobody hand-edits these files in bulk.

## Adding or retranslating a language

```bash
cd apps/ui

# 1. Offer every translatable string in en.ts, keyed by a stable id.
yarn i18n:locale:extract -- --locale fr --out /tmp/fr.todo.json

# 2. Fill in the translations: { "<key>": "<translation>" }.

# 3. Check the map before it touches the repo.
yarn i18n:locale:verify -- --translations /tmp/fr.json

# 4. Write the locale file. Use --out first to diff before replacing anything.
yarn i18n:locale:build -- --locale fr --translations /tmp/fr.json --out /tmp/fr.preview.ts
yarn i18n:locale:build -- --locale fr --translations /tmp/fr.json
```

Building only writes the locale file. Registering it is three edits, each a deliberate decision:

| File | Edit |
|---|---|
| `../_all.ts` | add the code to `SupportedLanguage` and its `nativeName` (the language picker is data-driven off this — no UI change needed) |
| `../i18n.ts` | import it and add a **thunk** to `TRANSLATION_TREE_BY_LANGUAGE`, so only the active language is materialised |
| `../i18n.integrity.test.ts` | add it to the locale lists, so it is held to the same completeness bar as every other language |

The tooling lives in `apps/ui/tools/i18n/`. It rewrites only the *interior* of string and template
literals, which is what keeps structure intact; `localeLiterals.test.ts` pins that with a round-trip
over every file in this folder.

## Rules that apply to every language

1. **`${...}` interpolations are structure.** You translate the text *between* them. A fragment may
   legitimately be a bare connector like `" and "` — translate it as a connector.
2. **Leading and trailing whitespace is load-bearing.** `" and "` must come back with both spaces.
   A trimmed fragment glues two words onto the interpolated value.
3. **Code stays byte-identical**: CLI invocations, paths, globs, flags, config keys, env vars,
   identifiers and URLs. A localised `happier attach <session-id>` is a command that does not run.
4. **Product names never translate**: Happier, Claude, Codex, Gemini, Cursor, Copilot, OpenCode,
   Qwen, Kimi, Pi, GitHub, MCP, tmux, zellij.
5. **Match the shape of the source**: no trailing period if the English has none; ALL CAPS stays
   ALL CAPS; a `\n` count must be preserved.
6. **Short source, short translation.** A string of ≤12 characters is a control label living in a
   button or tab that does not reflow. "Cancel" → « Annuler », not « Annuler l'opération ».
7. A value identical to the English is reported by the integrity test. Sometimes that is correct
   (product names, true cognates) — those get an explicit allowlist entry, not a silent pass.

## French (`fr`)

**Register: tutoiement.** Happier addresses the user as **tu**, never *vous*. This is a ratified
product decision — Happier is a warm companion for developers, and modern French developer tooling
tutoies. Imperatives take the *tu* form: "Choose a model" → « Choisis un modèle ».

**Technical vocabulary stays in English** — these are the words French developers actually say. Do
not francise them, do not italicise them.

| English | French |
|---|---|
| commit | un commit |
| branch | une branche *(this one IS francised — universally used)* |
| worktree | un worktree |
| repository | un dépôt |
| merge / rebase / stash | fusionner / rebaser / un stash |
| pull request | une pull request |
| prompt | un prompt *(never « invite »)* |
| provider | un provider *(never « fournisseur »)* |
| workspace | un workspace |
| token | un token *(never « jeton »)* |
| agent, backend, daemon, relay, plugin, pool, runtime, sandbox, webhook | unchanged |

**Typography** — French rules are enforced by eye, not by the compiler, so they are easy to lose:

- Narrow no-break space **U+202F** before `? ! : ;` and inside `« … »`.
- Typographic apostrophe **’**, never ASCII `'`.
- Ellipsis is the single character **…**.
- Decimal comma; space as thousands separator (1 234,5).

**Length**: French runs 15–20 % longer than English. Body copy may run long; control labels may not.

**Tone**: warm, direct, present tense, active voice. Errors say what happened and what to do next —
they do not apologise and do not blame. Avoid « veuillez » and administrative French. Read each
string aloud in your head: if it sounds like a bank letter, rewrite it.
