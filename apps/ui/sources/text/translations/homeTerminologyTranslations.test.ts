import { describe, expect, it } from 'vitest';

import { ca } from './ca';
import { de } from './de';
import { en } from './en';
import { es } from './es';
import { fr } from './fr';
import { it as itTranslations } from './it';
import { ja } from './ja';
import { pl } from './pl';
import { pt } from './pt';
import { ru } from './ru';
import { zhHans } from './zh-Hans';
import { zhHant } from './zh-Hant';

const LOCALES = { ca, de, en, es, fr, it: itTranslations, ja, pl, pt, ru, zhHans, zhHant } as const;
const REACHABILITY_LOCALES = { de, en, es, fr, it: itTranslations, ja, pl, pt, ru, zhHans } as const;

const TRANSPORT_OR_SERVER_NOUN = /relay|relais|relé|relè|реле|ретрансл|リレー|中继|中繼|server|serveur|servidor|serwer|сервер|サーバー|服务器|伺服器/i;

// Endpoint-facing copy whose English source says "Home": every locale must name the Home, never a relay/server.
const HOME_ENDPOINT_COPY_KEYS = [
    'server.enterServerUrl', 'server.notValidHappyServer', 'server.continueWithServer', 'server.resetServerDefault',
    'server.validatingServer', 'server.serverReturnedError', 'server.failedToConnectToServer',
    'server.currentlyUsingCustomServer', 'server.useThisServer', 'server.renameServer', 'server.renameServerPrompt',
    'server.renameServerGroup', 'server.renameServerGroupPrompt', 'server.serverNamePlaceholder',
    'server.cannotRenameCloud', 'server.removeServer', 'server.removeServerGroup', 'server.removeServerGroupConfirm',
    'server.cannotRemoveCloud', 'server.signOutThisServer', 'server.signOutThisServerPrompt', 'server.switchToServer',
    'server.addServerSubtitle', 'server.notificationAddServerHint', 'server.serverCount',
    'server.useCanonicalServerUrlTitle', 'server.useCanonicalServerUrlBody', 'server.insecureHttpUrlTitle',
    'server.addServerGroupTitle', 'server.addServerGroupSubtitle', 'server.serverGroupNamePlaceholder',
    'server.serverGroupServersLabel', 'server.serverGroupMustHaveServer', 'welcome.serverIncompatibleTitle',
    'setupOnboarding.changeRelay', 'setupOnboarding.relayCustomUrlTitle', 'setupOnboarding.relayCustomUrlSubtitle',
    'setupOnboarding.savedRelaysTitle', 'setupOnboarding.removeRelayConfirmTitle', 'setupOnboarding.removeRelayConfirmBody',
    'setupOnboarding.relayNameLabel', 'setupOnboarding.addAndUseRelay', 'setupOnboarding.changeRelayAction',
    'setupOnboarding.continueToAuth', 'setupOnboarding.continueWithLocalRelayAction',
    'setupOnboarding.confirmSwitchRelayTitle', 'setupOnboarding.confirmSwitchRelaySubtitle',
    'setupOnboarding.confirmSwitchRelayKeepTitle', 'setupOnboarding.confirmSwitchRelayKeepSubtitle',
    'setupOnboarding.confirmSwitchRelaySwitchTitle', 'setupOnboarding.confirmSwitchRelaySwitchSubtitle',
    'setupOnboarding.confirmSwitchRelayWarning',
    'setupOnboarding.thisComputerStages.useRelayAccountMismatchSubtitle',
    'setupOnboarding.thisComputerStages.useRelayNeedsAuthSubtitle',
    'setupOnboarding.thisComputerStages.useRelaySignedInSubtitle',
    'setupOnboarding.thisComputerStages.useRelayMissingSubtitle',
    'setupOnboarding.thisComputerStages.registerComputerReconnectSubtitle',
] as const;

// Leaves that name the Home product object: every locale keeps the English product noun, never a native noun.
const HOME_PRODUCT_NOUN_KEYS = [
    'personalHome.auth.signupClosed', 'personalHome.bootstrap.title', 'personalHome.bootstrap.checkingStatus',
    'personalHome.bootstrap.ensuringHomeStatus', 'personalHome.bootstrap.preparingComputerStatus',
    'personalHome.bootstrap.blockedStatus', 'personalHome.bootstrap.readyStatus',
    'personalHome.bootstrap.profileRecoveryBody', 'personalHome.bootstrap.computerRecoveryBody',
    'personalHome.bootstrap.existingRuntimeBody', 'personalHome.bootstrap.useExisting',
    'personalHome.bootstrap.useExistingDetail', 'personalHome.bootstrap.useAnother', 'personalHome.bootstrap.useAnotherDetail',
    'personalHome.bootstrap.blocked.runtime_unhealthy', 'personalHome.bootstrap.blocked.home_auth_invalid',
    'personalHome.bootstrap.blocked.existing_runtime', 'personalHome.bootstrap.blocked.personal_home_erased',
    'personalHome.bootstrap.blockedBody.personal_home_erased', 'personalHome.settings.defaultHomeLabel',
    'personalHome.settings.summaryTitle', 'newSession.temporaryComputer.target.home', 'settingsAccount.currentHome',
    'settingsNotifications.push.currentHome', 'settingsAccount.logoutSubtitle',
] as const;

const NATIVE_HOME_NOUN = /zuhause|maison|foyer|hogar|\bcas[ae]\b|\bllar|\bdom(u|em|ie)?\b|(^|[^а-яё])дом(а|ом|е|у)?([^а-яё]|$)|ホーム|之家|家庭/i;

// Sign-in-service corridor copy that previously shipped as byte-identical English in every locale.
const SIGN_IN_SERVICE_CORRIDOR_KEYS = [
    'settingsAccount.accountServiceDiscoveryDescription',
    'settingsAccount.accountServiceDiscoveringHomes', 'settingsAccount.accountServiceDiscoveryUnsupported',
    'settingsAccount.accountServiceDiscoveryUnavailable', 'settingsAccount.accountServiceDiscoveryUnavailableDescription',
    'settingsAccount.accountServiceHomesEmpty', 'settingsAccount.accountServiceConnectHome',
    'settingsAccount.accountServiceRetryHomeConnection', 'settingsAccount.accountServiceHomeConnected',
    'settingsAccount.accountServiceHomeApprovalRequired', 'settingsAccount.accountServiceHomeConnectionFailed',
] as const;

function renderLeaf(translations: object, path: string): string | undefined {
    let node: unknown = translations;
    for (const segment of path.split('.')) {
        if (node === null || typeof node !== 'object') return undefined;
        node = (node as Record<string, unknown>)[segment];
    }
    if (typeof node === 'string') return node;
    if (typeof node === 'function') return String(node({ name: 'NAME', count: 2, provider: 'PROVIDER', host: 'HOST', home: 'HOME', serverUrl: 'URL' }));
    return undefined;
}

function collectLeaves(node: unknown, path: string, out: Array<[string, string]>): Array<[string, string]> {
    if (typeof node === 'string') out.push([path, node]);
    else if (typeof node === 'function') out.push([path, renderLeaf({ leaf: node }, 'leaf') ?? '']);
    else if (node !== null && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) collectLeaves(child, path ? `${path}.${key}` : key, out);
    }
    return out;
}

describe('Home terminology translations', () => {
    it('keeps the Home product noun distinct from the localized navigation label', () => {
        expect(Object.entries(LOCALES).map(([locale, translations]) => [locale, translations.common.homeProductName]))
            .toEqual(Object.keys(LOCALES).map((locale) => [locale, 'Home']));
    });

    it('uses Home, not Relay, for ordinary Home profiles, groups, and daemon alignment', () => {
        const failures = Object.entries(LOCALES).flatMap(([locale, translations]) => {
            const { multiServerView, relayDrift } = translations.server;
            const { retention } = translations.server;
            const values = [
                translations.server.serverConfiguration,
                translations.server.autoConfigHint,
                multiServerView.title,
                multiServerView.footer,
                multiServerView.presentationTitle,
                multiServerView.presentation.flatWithBadges,
                multiServerView.presentation.groupedByServer,
                translations.machine.thisComputer.title.daemon_url_mismatch,
                translations.machine.thisComputer.description.daemon_url_mismatch({ home: 'HOME_A', daemonHome: 'HOME_B' }),
                translations.machine.thisComputer.title.daemon_needs_auth,
                translations.machine.thisComputer.description.daemon_needs_auth({ home: 'HOME_A' }),
                translations.machine.thisComputer.title.daemon_not_configured,
                translations.machine.thisComputer.description.daemon_not_configured({ home: 'HOME_A' }),
                translations.machine.thisComputer.action.daemon_url_mismatch,
                relayDrift.progressTitle,
                relayDrift.progressStepConfigureRelay,
                retention.relayCleanupSummary({ policies: 'POLICIES' }),
                retention.sessionNotice({ count: 2 }),
            ];

            return values.some((value) => /relay|server/i.test(value))
                || !values.slice(-2).every((value) => /Home/.test(value))
                ? [`${locale}: ordinary Home copy still uses Relay or Server`]
                : [];
        });

        expect(failures).toEqual([]);
    });

    it('names the Home, never a relay or server, wherever the English endpoint copy says Home', () => {
        const failures = Object.entries(LOCALES).flatMap(([locale, translations]) => HOME_ENDPOINT_COPY_KEYS.flatMap((key) => {
            const value = renderLeaf(translations, key);
            return value === undefined || (TRANSPORT_OR_SERVER_NOUN.test(value) || !/Home/.test(value))
                ? [`${locale}: ${key} = ${String(value)}`]
                : [];
        }));

        expect(failures).toEqual([]);
    });

    it('keeps the English Home product noun wherever a leaf names the Home object', () => {
        const failures = Object.entries(LOCALES).flatMap(([locale, translations]) => HOME_PRODUCT_NOUN_KEYS.flatMap((key) => {
            const value = renderLeaf(translations, key);
            return value === undefined || NATIVE_HOME_NOUN.test(value) || !/Home/.test(value)
                ? [`${locale}: ${key} = ${String(value)}`]
                : [];
        }));

        expect(failures).toEqual([]);
    });

    it('translates the sign-in-service corridor instead of shipping English copy', () => {
        const failures = Object.entries(LOCALES).filter(([locale]) => locale !== 'en').flatMap(([locale, translations]) =>
            SIGN_IN_SERVICE_CORRIDOR_KEYS.flatMap((key) => {
                const value = renderLeaf(translations, key);
                return value === undefined || value === renderLeaf(en, key) ? [`${locale}: ${key} = ${String(value)}`] : [];
            }));

        expect(failures).toEqual([]);
    });

    it('describes Tailscale as the way to reach a Home, not a relay', () => {
        const failures = Object.entries(REACHABILITY_LOCALES).flatMap(([locale, translations]) => {
            const copy = translations.server.reachabilityRemediation.tailscale;
            const values = [copy.title, copy.desktopBody, copy.webBody, copy.nativeBody];
            return values.some((value) => /relay/i.test(value))
                || values.some((value) => !/Home/.test(value))
                ? [`${locale}: Tailscale remediation does not consistently identify the Home`]
                : [];
        });

        expect(failures).toEqual([]);
    });
    it('names Personal Home one way per locale across the Personal Home settings section', () => {
        const failures = Object.entries(LOCALES).flatMap(([locale, translations]) => {
            const productLabel = translations.personalHome.settings.summaryTitle;
            if (productLabel === 'Personal Home') return [];
            return collectLeaves(translations.personalHome.settings, 'personalHome.settings', [])
                .filter(([, value]) => /Personal Home/.test(value))
                .map(([key, value]) => `${locale}: ${key} = ${value} (label: ${productLabel})`);
        });

        expect(failures).toEqual([]);
    });

    it('keeps one tu register in the Portuguese Personal Home settings section', () => {
        const formal = /\b(Reveja|Consulte|Tente|Guarde|Verifique|Escolha|Selecione|Aguarde|Mantenha|Use|Abra|Inicie)\b/;
        const failures = collectLeaves(pt.personalHome.settings, 'personalHome.settings', [])
            .filter(([, value]) => formal.test(value))
            .map(([key, value]) => `${key} = ${value}`);

        expect(failures).toEqual([]);
    });

    it('localizes the Team noun in French team sign-in and join copy', () => {
        const leaves = [
            ...collectLeaves(fr.teams.entry, 'teams.entry', []),
            ...collectLeaves(fr.teams.join, 'teams.join', []),
        ];
        const failures = leaves
            .filter(([, value]) => /\bTeam\b/u.test(value))
            .map(([key, value]) => `${key} = ${value}`);

        expect(failures).toEqual([]);
        expect(fr.teams.entry.signInServiceOrigin({ service: 'Service Exemple' }))
            .toContain('Service Exemple');
    });
});
