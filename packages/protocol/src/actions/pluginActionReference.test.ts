import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { getActionSpec, listActionSpecsForSurface } from './actionSpecs.js';
import { canRequestPresentUserApprovalForActionInputV1, DECISION_ACTION_IDS, requiresPresentUserDecisionForActionInputV1,
  resolveCredentialActionAdmissionV1, TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS } from './decisionAuthority.js';
import { renderPluginActionReferenceMarkdown } from './pluginActionReference.js';

const actionReferencePath = fileURLToPath(
  new URL('../../../../apps/docs/content/docs/plugins/api/host-actions.mdx', import.meta.url),
);

function readRenderedActionIds(markdown: string): readonly string[] {
  return [...markdown.matchAll(/^## `([^`]+)`$/gmu)].map((match) => match[1]!);
}

describe('plugin Action reference generator', () => {
  it('renders every and only canonical Plugin-surfaced ActionSpec', () => {
    const expectedActionIds = listActionSpecsForSurface('plugin')
      .map((spec) => spec.id)
      .sort();
    const markdown = renderPluginActionReferenceMarkdown();

    expect(readRenderedActionIds(markdown)).toEqual(expectedActionIds);
    expect(markdown).toContain('context.services.actions.execute');
    expect(markdown).toContain('canonical ActionSpec registry');
  });

  it('separates plugin request admission from canonical decision/effect authority', () => {
    const markdown = renderPluginActionReferenceMarkdown();
    const actionSpecs = listActionSpecsForSurface('plugin');
    const presentUserRows = actionSpecs.filter((spec) => spec.requiredAuthority === 'present_user');
    expect(presentUserRows.length).toBeGreaterThan(0);

    for (const spec of actionSpecs) {
      const section = markdown.split(`## \`${spec.id}\``)[1] ?? '';
      const body = section.split('## `')[0] ?? '';
      const decision = (DECISION_ACTION_IDS as readonly string[]).includes(spec.id);
      const conversational = (TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS as readonly string[]).includes(spec.id);
      const effectAuthority = decision ? 'approval_decision' : conversational ? 'conversational_input'
        : spec.requiredAuthority === 'present_user' ? 'present_user'
        : requiresPresentUserDecisionForActionInputV1(spec) ? 'human_decision' : 'account_automation';
      expect(body).toContain(`- Decision/effect authority: \`${effectAuthority}\``);
      const mayRequestApproval = canRequestPresentUserApprovalForActionInputV1(spec);
      const pluginAdmission = resolveCredentialActionAdmissionV1({
        spec, authority: 'account_automation', grant: null, surface: 'plugin',
      });
      const requestAdmission = decision ? 'approval_decision' : conversational ? 'conversational_input'
        : !pluginAdmission.ok ? 'present_user'
        : mayRequestApproval ? 'human_approval' : 'account_automation';
      expect(body).toContain(`- Request admission: \`${requestAdmission}\``);
      if (mayRequestApproval && !conversational) {
        expect(resolveCredentialActionAdmissionV1({
          spec, authority: 'account_automation', grant: null, surface: 'api', hasExternalCredential: true,
        })).toEqual({ ok: false, errorCode: 'present_user_required' });
      }
    }
  });

  it('documents credential decision and conversational exceptions without granting security authority', () => {
    const markdown = renderPluginActionReferenceMarkdown();
    for (const id of DECISION_ACTION_IDS) {
      const spec = getActionSpec(id);
      const credential = { spec, authority: 'account_automation' as const, surface: 'api', hasExternalCredential: true };
      expect(resolveCredentialActionAdmissionV1({ ...credential, grant: API_TOKEN_FULL_GRANT_V1 })).toEqual({ ok: false, errorCode: 'present_user_required' });
      expect(resolveCredentialActionAdmissionV1({ ...credential, grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true } })).toEqual({ ok: true });
      expect(markdown.split(`## \`${id}\``)[1]?.split('## `')[0]).toContain('- Decision/effect authority: `approval_decision`');
    }
    const permission = getActionSpec('session.permission.respond');
    expect(resolveCredentialActionAdmissionV1({ spec: permission, authority: 'account_automation', grant: null, surface: 'agent' })).toEqual({ ok: true });
    for (const id of TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS) {
      const spec = getActionSpec(id);
      expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: API_TOKEN_FULL_GRANT_V1, surface: 'api', hasExternalCredential: true })).toEqual({ ok: true });
      expect(markdown.split(`## \`${id}\``)[1]?.split('## `')[0]).toContain('- Decision/effect authority: `conversational_input`');
    }
    expect(resolveCredentialActionAdmissionV1({ spec: getActionSpec('account.apiTokens.create'), authority: 'account_automation',
      grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true }, surface: 'api', hasExternalCredential: true })).toEqual({ ok: false, errorCode: 'present_user_required' });
  });

  it('keeps the published reference synchronized with the canonical registry', () => {
    expect(readFileSync(actionReferencePath, 'utf8')).toBe(
      renderPluginActionReferenceMarkdown(),
    );
  });
});
