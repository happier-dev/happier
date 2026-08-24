import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

import {
    TRIAGE_ACTIONS_SETTING_ID_V1,
    triageActionsSettingFieldJsonSchemaV1,
} from './actions.js';

/**
 * The one declared Account Settings field the configured action catalog owns.
 *
 * It is declared so the value has a real home in the Account record, and it is
 * hidden for the same reason `triage.savedViews` is: the declarative Settings
 * form has text, switch, select, number and JSON controls and no repeatable
 * record editor, so presenting a catalog through it would mean handing a person
 * raw JSON and calling it configuration. Add, remove, rename, reorder, disable
 * and configure are the editor mounted on the PRs & Issues page, which reaches
 * this exact key through the two `actions/*-v1` Actions.
 *
 * An absent value is not an empty catalog: `settings/actions.ts` reads absence
 * as the shipped Ask/Fix/Review seed, which is why `default` here is the same
 * empty-set shape `triage.savedViews` declares — the host boundary needs a
 * shape, and the seed is the owner's answer to absence, not a stored value this
 * declaration should pre-write on every Account.
 *
 * **The schema is PROJECTED, never restated.** It used to be a hand-written
 * JSON Schema spelling the same members a second time, and it drifted: it
 * declared `reviewStart` as a closed `{ kind }` while the record, the wire and
 * the shipped "Run code review" seed all carry `promptInvocationId` there. The
 * host compiles this declaration and refuses a `set` that fails it, so the
 * catalog Happier ships could not be written back. Projecting the one grammar
 * in `settings/actions.ts` is what makes that class of divergence unexpressible.
 *
 * The declaration remains a shape guard, not the authority: `actions.ts` still
 * owns the UTF-8 byte bounds, the single-line normalization, the
 * duplicate-subject refusal, the whole-value ceiling and the CAS decision,
 * because a JSON-Schema declaration cannot express "at most 64 KiB for the
 * whole value" or "a subject named twice is refused rather than deduplicated".
 */
export const TRIAGE_ACTIONS_SETTINGS_CONTRIBUTION_V1 = {
    id: 'actions',
    title: 'Actions',
    description: 'The things you can start from a pull request, issue or error group.',
    target: { kind: 'plugin' },
    scope: 'account',
    fields: [{
        id: TRIAGE_ACTIONS_SETTING_ID_V1,
        title: 'Actions',
        schema: triageActionsSettingFieldJsonSchemaV1(),
        default: { v: 1, actions: [] },
        presentation: { hidden: true },
    }],
} satisfies PluginSettingsContribution;
