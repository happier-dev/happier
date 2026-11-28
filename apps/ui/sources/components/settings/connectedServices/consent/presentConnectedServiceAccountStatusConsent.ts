import { resolveConnectedServicePoolConsentPolicy } from '@happier-dev/agents';
import type { ConnectedServiceId } from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

/**
 * The one ask before account reads turn on for consent-gated services: turning on an agent's
 * "Show quota and account status", or creating a pool of such a service. Resolves `true` when the
 * person continues, or when none of the services needs consent. "Learn more" opens the provider
 * page and asks again, so reading the page never counts as an answer; dismissing means no.
 *
 * The copy names Google: every provider declaring consent today is a Google service; a non-Google
 * declaration needs its own notice text.
 */
export async function presentConnectedServiceAccountStatusConsent(
    serviceIds: ReadonlyArray<ConnectedServiceId>,
): Promise<boolean> {
    const policies = serviceIds
        .map((serviceId) => resolveConnectedServicePoolConsentPolicy(serviceId))
        .filter((policy) => policy.required);
    if (policies.length === 0) return true;
    const learnMoreUrl = policies.find((policy) => policy.learnMoreUrl)?.learnMoreUrl ?? null;

    for (;;) {
        // A holder object: the button callbacks assign it, which control-flow narrowing cannot see.
        const choice: { answer: 'continue' | 'cancel' | 'learn_more' } = { answer: 'cancel' };
        await Modal.alertAsync(
            t('connectedServices.accountStatusConsent.noticeTitle'),
            t('connectedServices.accountStatusConsent.noticeBody'),
            [
                ...(learnMoreUrl ? [{
                    text: t('connectedServices.accountStatusConsent.learnMore'),
                    onPress: () => { choice.answer = 'learn_more'; },
                }] : []),
                { text: t('common.cancel'), style: 'cancel' as const, onPress: () => { choice.answer = 'cancel'; } },
                { text: t('common.continue'), onPress: () => { choice.answer = 'continue'; } },
            ],
        );
        if (choice.answer !== 'learn_more' || !learnMoreUrl) return choice.answer === 'continue';
        await openExternalUrl(learnMoreUrl);
    }
}
