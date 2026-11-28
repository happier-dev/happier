import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI_SOURCES_ROOT = join(__dirname, '..', '..');

const ALLOWED_DIRECT_ACCOUNT_WRITE_FILES = new Set([
    'components/onboarding/checklists/remoteSsh/persistRemoteHostAfterRemoteSshCompletion.ts',
    // New Session writes its preferences against the Account settings scope it captured at render
    // (88b3a562c4), which a hook-bound writer cannot carry across the async creation flow.
    'components/sessions/new/NewSessionScreen.tsx',
    'components/sessions/new/hooks/screenModel/useNewSessionBackendTargetState.ts',
    'components/sessions/new/hooks/useCreateNewSession.ts',
    'components/sessions/new/hooks/useNewSessionScreenModel.tsx',
    'components/sessions/new/modules/newSessionDraftLifecycle.ts',
    // Machine-administration target memory is written against the controller scope that selected it.
    'components/settings/machines/managed/useManagedControllerScope.tsx',
    'sync/domains/machines/administration/selectionPreferences.ts',
    'sync/domains/machines/administration/useTargetSelection.ts',
    'sync/ops/actions/defaultActionExecutor.ts',
    'sync/store/settingsWriters.ts',
    'voice/persistence/invalidatePersistentVoiceTranscript.ts',
    'voice/persistence/voiceAutoTargetMachineSettings.ts',
]);

const ALLOWED_DIRECT_LOCAL_WRITE_FILES = new Set([
    'hooks/server/useHomeViewSelectionSettings.ts',
    'sync/ops/actions/connectedServiceActionDeps.ts',
    'sync/ops/actions/defaultActionExecutor.ts',
    'sync/store/settingsWriters.ts',
    'sync/store/domains/settings.ts',
    'sync/domains/settings/localSettings.ts',
    // Device-local view state and acknowledgements are written on the storage store directly so they
    // persist even when Account Settings writes are Off (378b0932b8, d5803bb586). They are not Setting
    // declarations, so the Setting writer hooks do not apply.
    'auth/context/AuthContext.tsx',
    'components/appShell/panes/AppPaneProvider.tsx',
    'components/appShell/workspace/useWorkspaceState.ts',
    'components/artifacts/ArtifactsBrowserScreen.tsx',
    'components/machines/vitals/MachineVitalsRangeBar.tsx',
    'components/navigation/shell/SidebarNavigator.tsx',
    'components/navigation/shell/appRail/AppRailMachines.tsx',
    'components/onboarding/personalize/usePersonalizeFlow.ts',
    'components/sessions/bots/BotsPopoverContent.tsx',
    'components/sessions/composerBanners/ComposerBannerCollapseProvider.tsx',
    'components/sessions/shell/SessionView.tsx',
    'components/sessions/shell/useSessionListViewState.tsx',
    'components/settings/connectedServices/ConnectedServicesSettingsView.tsx',
    'components/settings/session/SessionComposerSettingsView.tsx',
    'components/terminal/embedded/EmbeddedTerminalPane.native.tsx',
    'components/terminal/qa/TerminalQaScreen.native.tsx',
    'sync/api/account/apiConnectedMetadataCatalog.ts',
    'sync/ops/actions/petChooseAction.ts',
    'sync/store/hooks.ts',
]);

/**
 * `applySettingsLocal` is the settings store's internal projection leaf. Reaching it directly
 * skips scope admission, sealing, pending merge, analytics and server synchronization, so every
 * entry here is named with the reason it is not a server-backed Account write (Lane 07.6 §2).
 */
const ALLOWED_RAW_LOCAL_PROJECTION_FILES = new Set([
    // The canonical settings engine and store: this projection is their own implementation.
    'sync/engine/settings/syncSettings.ts',
    'sync/store/domains/settings.ts',
    // The one catalogued local-only compatibility projection: device/tab Home selection is owned
    // by the device-global Home-view state and must never enter Account-settings sync.
    'hooks/server/useHomeViewSelectionSettings.ts',
    // The answering client's own encryption requirement is a local-only projection of the Account
    // requirement it sets (c973795686); it is not a server-backed Account write.
    'sync/ops/settings/setClientEncryptionRequirement.ts',
    // Test, development and Voice-QA harnesses that install fixture settings into a throwaway runtime.
    // They ship in the source tree but are never a product write path for a real Account.
    'components/sessions/files/views/sessionFilesViewTestkit.ts',
    'dev/testkit/harness/standaloneVoicePolicyHarness.ts',
    'dev/testkit/harness/useVoiceSurfaceE2eFixtureComposition.ts',
    'voice/qa/voiceQaRecordedAudioController.ts',
    'voice/qa/voiceQaTemporarySettingsScope.ts',
]);

function walkSourceFiles(root: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(root)) {
        const fullPath = join(root, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            const relativePath = relative(UI_SOURCES_ROOT, fullPath).replaceAll('\\', '/');
            if (entry === 'node_modules' || entry === '__tests__' || entry === 'testSupport'
                || relativePath === 'dev/testkit') continue;
            results.push(...walkSourceFiles(fullPath));
            continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        // The capability guard uses these explicit fixture suffixes, not loose path substrings.
        if (/(?:\.(?:test|spec)|testSupport|testHelpers|testHarness|testkit|testFixtures)\.(ts|tsx)$/i.test(entry)) continue;
        results.push(fullPath);
    }
    return results;
}

// This is an architecture inventory, not three independent filesystem tests.
// Read the production corpus once so the assertions remain cheap even as the
// UI source tree grows.
const PRODUCTION_SOURCE_FILES = walkSourceFiles(UI_SOURCES_ROOT).map((fullPath) => ({
    relativePath: relative(UI_SOURCES_ROOT, fullPath).replaceAll('\\', '/'),
    contents: readFileSync(fullPath, 'utf8'),
}));

function collectViolations(pattern: RegExp, allowlist: Set<string>): string[] {
    return PRODUCTION_SOURCE_FILES
        .filter(({ relativePath, contents }) => pattern.test(contents) && !allowlist.has(relativePath))
        .map(({ relativePath }) => relativePath)
        .sort();
}

describe('settings writer architecture', () => {
    it('keeps direct sync.applySettings usage inside approved writer and system files only', () => {
        const violations = collectViolations(
            /(?:\bsync|getSyncSingleton\(\))\.applySettings\s*\(/,
            ALLOWED_DIRECT_ACCOUNT_WRITE_FILES,
        );
        expect(violations).toEqual([]);
    });

    it('keeps direct local settings store writes inside approved writer files only', () => {
        const violations = collectViolations(/applyLocalSettings\s*\([^)]*,\s*\{\s*source:/, ALLOWED_DIRECT_LOCAL_WRITE_FILES);
        expect(violations).toEqual([]);
    });

    it('keeps raw Account-settings local projection out of production server-backed writers', () => {
        const violations = collectViolations(/applySettingsLocal\s*\(/, ALLOWED_RAW_LOCAL_PROJECTION_FILES);
        expect(violations).toEqual([]);
    });

    it('does not reintroduce the obsolete lower-currentness Account-settings replacement branch', () => {
        expect(collectViolations(/replaceSettingsForScope\s*[:(]/, new Set())).toEqual([]);
    });
});
