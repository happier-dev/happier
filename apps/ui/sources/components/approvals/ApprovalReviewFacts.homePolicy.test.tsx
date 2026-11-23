import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');
const actionId = 'home.policy.set';

beforeEach(async () => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
});
afterEach(() => { standardCleanup(); setPreferredLanguageFromSettings('en'); });

it.each([
    { policy: { v: 1, mode: 'public_only' }, key: 'homeGovernance.signInProviders.privateEndpointsPublicOnlyShort' },
    { policy: { v: 1, mode: 'private_allowlist', hostnames: ['id.internal.test'], cidrs: ['192.0.2.0/24'], ports: [443] },
        key: 'homeGovernance.signInProviders.privateEndpointsAllowlistShort' },
] as const)('displays the selected identity network mode $policy.mode using the Home picker label', async ({ policy, key }) => {
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId}
        actionArgs={getActionSpec(actionId).inputSchema.parse({ expectedRevision: 1, identityNetworkPolicy: policy })}
        preview={null} serverId={null} testID="home-policy-review" />);
    try {
        const text = screen.getTextContent();
        expect(text).toContain(t(key));
        expect(text).not.toContain(policy.mode);
        if (policy.mode === 'private_allowlist') expect(text).toContain('id.internal.test');
    } finally { await screen.unmount(); }
});

const nullableFields = [
    ['authenticationPolicy', 'homeGovernance.signInTitle'],
    ['teamProviderPolicy', 'homeGovernance.activity.fieldTeamProviders'],
    ['identityNetworkPolicy', 'homeGovernance.privateEndpoints'],
    ['sessionDefaults', 'settingsAgents.detailPage.sessionDefaultsTitle'],
] as const;

it.each(nullableFields)('shows an explicit %s clear and omits untouched policy sections', async (field, key) => {
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId}
        actionArgs={getActionSpec(actionId).inputSchema.parse({ expectedRevision: 1, [field]: null })}
        preview={null} serverId={null} testID="home-policy-review" />);
    try {
        const text = screen.getTextContent();
        expect(text).toContain(t(key));
        expect(text).toContain(t('homeSettings.row.notSet'));
        for (const [other, otherKey] of nullableFields) {
            if (other !== field) expect(text).not.toContain(t(otherKey));
        }
    } finally { await screen.unmount(); }
});
