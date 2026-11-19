import { describe, expect, it } from 'vitest';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { t } from '@/text';
import { projectOpenRefusalPresentation } from './projectOpenRefusalPresentation';

describe('Project Open refusal presentation', () => {
    it('shows the credential repair supplied by the owning clone failure', () => {
        expect(projectOpenRefusalPresentation('REMOTE_AUTH_REQUIRED', null, {
            kind: 'auth_required', label: 'Sign in on the selected machine.',
        })).toMatchObject({ title: t('errors.authenticationFailed'), description: 'Sign in on the selected machine.' });
    });
    it('names the repository the Git account could not read, keeping the owner\'s repair beneath it', () => {
        expect(projectOpenRefusalPresentation('REMOTE_AUTH_REQUIRED', null, {
            kind: 'auth_required', label: 'Sign in on the selected machine.',
        }, 'github.com/acme/app')).toMatchObject({
            title: t('projects.open.gitDenied', { repository: 'github.com/acme/app' }),
            description: 'Sign in on the selected machine.',
        });
    });
    it('distinguishes missing clone support from an unavailable Source hosting provider', () => {
        expect(projectOpenRefusalPresentation('FEATURE_UNSUPPORTED', null).title).toBe(t('projects.open.cloneUnsupported'));
        expect(projectOpenRefusalPresentation('BACKEND_UNAVAILABLE', null).title).toBe(t('projects.open.hostingProviderUnavailable'));
    });
    it('offers target recovery without claiming the machine is offline or incapable', () => {
        expect(projectOpenRefusalPresentation('target_mismatch', null)).toMatchObject({
            title: t('projects.open.targetMismatch'), description: t('projects.open.targetMismatchHint'),
        });
    });
    it('guides the user to update a Machine that lacks Project Open', () => {
        expect(projectOpenRefusalPresentation(RPC_ERROR_CODES.UPDATE_REQUIRED, null)).toMatchObject({
            title: t('errors.machineActionUnsupported'), details: [RPC_ERROR_CODES.UPDATE_REQUIRED],
        });
    });
    it('retains distinct Source and transport refusals', () => {
        expect(projectOpenRefusalPresentation('source_changed', null).title).toBe(t('projects.open.sourceChanged'));
        expect(projectOpenRefusalPresentation('machine_unreachable', null).title).toBe(t('workspaceSync.start.blocked.targetMachineOffline'));
        expect(projectOpenRefusalPresentation('machine_offline', null).title).toBe(t('workspaceSync.start.blocked.targetMachineOffline'));
    });
    it('gives every typed refusal a cause and a next step, never its code', () => {
        const typed = ['REMOTE_AUTH_REQUIRED', 'REMOTE_RATE_LIMITED', 'FEATURE_UNSUPPORTED', 'BACKEND_UNAVAILABLE', 'target_mismatch',
            'machine_offline', 'ref_not_found', 'invalid_folder', 'source_changed', 'source_unavailable',
            'requester_authority_unavailable', 'requester_account_unavailable', 'session_requester_unavailable',
            'machine_admission_unavailable', 'machine_access_denied', 'invalid_input'];
        for (const code of typed) {
            const shown = projectOpenRefusalPresentation(code, 'main');
            expect(shown.title, code).not.toBe(t('projects.open.failed'));
            expect(shown.title, code).not.toBe(t('projects.open.unsupported'));
            // These titles already say what to do next ("Try again in a few minutes", "Choose a folder…", "Review it, then open again").
            if (!['REMOTE_RATE_LIMITED', 'invalid_folder', 'source_changed'].includes(code)) expect(shown.description, code).toBeTruthy();
            expect([shown.title, shown.description], code).not.toContain(code);
            expect(`${shown.title} ${shown.description ?? ''}`, code).not.toMatch(/projects\.open\.|[a-z]+_[a-z_]+/);
        }
    });
    it.each(['invalid_directory', 'INVALID_PATH'])('names an unusable folder and keeps %s behind Details (Projects D2)', code => {
        const shown = projectOpenRefusalPresentation(code, null);
        expect(shown.title).not.toBe(t('projects.open.failed'));
        expect(shown.description).toBeTruthy();
        expect(`${shown.title} ${shown.description}`).not.toContain(code);
        expect(shown.details).toEqual([code]);
    });
    it('names Machine access separately from a failed access check', () => {
        expect(projectOpenRefusalPresentation('machine_access_denied', null).title)
            .not.toBe(projectOpenRefusalPresentation('requester_authority_unavailable', null).title);
    });
    it('says an unclassified failure honestly and keeps what failed behind Details, never the Action id', () => {
        const cause: ActionFailureCauseV1 = { phase: 'projects.open', errorClass: 'TypeError', errorCode: null, httpStatus: null };
        const shown = projectOpenRefusalPresentation('project_open_unavailable', null, undefined, null, cause);
        expect(shown.title).toBe(t('projects.open.failed'));
        expect(shown.description).toBe(t('projects.open.failedHint'));
        expect(shown.details).toEqual(['project_open_unavailable', 'TypeError']);
    });
    it('names a subfolder the repository lacks and says what to fix, with the code behind Details (TL-A 11-08)', () => {
        const shown = projectOpenRefusalPresentation('repository_subfolder_missing', null, undefined, 'owner/repo', undefined, 'packages/missing');
        expect(shown.title).toBe(t('projects.open.subfolderMissing'));
        expect(shown.description).toBe(t('projects.open.subfolderMissingHint', { subfolder: 'packages/missing' }));
        expect(shown.details).toEqual(['repository_subfolder_missing']);
    });
});
