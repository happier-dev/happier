import * as React from 'react';
import type { ScmFollowupAction } from '@happier-dev/protocol';

import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import { SourceControlUpdateButton, type SourceControlUpdateTheme } from './SourceControlUpdateControls';
import type { SourceControlPublishRemediationAction } from './resolveSourceControlPublishRepositoryRemediation';
import { validateScmFollowupOpenUrl } from './validateScmFollowupOpenUrl';

export type PublishRemediationHandlers = Readonly<{
    onConnectGitHub?: () => Promise<void> | void;
    onInstallGh?: () => Promise<void> | void;
    onUseManagedGh?: () => Promise<void> | void;
    onAuthenticateGh?: () => Promise<void> | void;
}>;

export function PublishRemediationAction(props: Readonly<{
    theme: SourceControlUpdateTheme;
    action: SourceControlPublishRemediationAction | null;
    onRun: (action: SourceControlPublishRemediationAction) => void;
}>) {
    const action = props.action;
    if (!action) return null;
    return (
        <SourceControlUpdateButton
            theme={props.theme}
            testID={getPublishRemediationActionTestId(action)}
            label={getPublishRemediationActionLabel(action)}
            kind="secondary"
            disabled={action.disabled}
            onPress={() => props.onRun(action)}
        />
    );
}

export async function runPublishRemediationAction(input: Readonly<{
    action: SourceControlPublishRemediationAction;
    openUrl?: (url: string) => Promise<void>;
    onConnectGitHub?: () => Promise<void> | void;
    onInstallGh?: () => Promise<void> | void;
    onUseManagedGh?: () => Promise<void> | void;
    onAuthenticateGh?: () => Promise<void> | void;
    setErrorCode: (value: string | null) => void;
}>) {
    if (input.action.disabled) return;
    if (input.action.kind === 'connect-github') {
        await input.onConnectGitHub?.();
        return;
    }
    if (input.action.kind === 'install-gh') {
        await input.onInstallGh?.();
        return;
    }
    if (input.action.kind === 'use-managed-gh') {
        await input.onUseManagedGh?.();
        return;
    }
    if (input.action.kind === 'authenticate-gh') {
        await input.onAuthenticateGh?.();
        return;
    }
    await openValidatedPublishFollowup(input.action.followup, input.openUrl, input.setErrorCode);
}

export function resolveRemediationHandlerAvailability(
    action: SourceControlPublishRemediationAction | null,
    handlers: PublishRemediationHandlers,
): SourceControlPublishRemediationAction | null {
    if (!action) return null;
    if (action.disabled) return action;
    if (hasPublishRemediationHandler(action, handlers)) return action;
    return { ...action, disabled: true };
}

function hasPublishRemediationHandler(
    action: SourceControlPublishRemediationAction,
    handlers: PublishRemediationHandlers,
): boolean {
    switch (action.kind) {
        case 'connect-github':
            return Boolean(handlers.onConnectGitHub);
        case 'install-gh':
            return Boolean(handlers.onInstallGh);
        case 'use-managed-gh':
            return Boolean(handlers.onUseManagedGh);
        case 'authenticate-gh':
            return Boolean(handlers.onAuthenticateGh);
        case 'open-browser':
            return true;
    }
}

async function openValidatedPublishFollowup(
    followup: Extract<ScmFollowupAction, { kind: 'openUrl' }>,
    openUrl: ((url: string) => Promise<void>) | undefined,
    setErrorCode: (value: string | null) => void,
) {
    const safe = validateScmFollowupOpenUrl(followup);
    if (!safe.ok) {
        setErrorCode('UNSAFE_URL');
        return;
    }
    await (openUrl ?? openExternalUrl)(safe.url);
}

function getPublishRemediationActionTestId(action: SourceControlPublishRemediationAction): string {
    switch (action.kind) {
        case 'connect-github':
            return 'scm-publish-remediation-connect-github';
        case 'install-gh':
            return 'scm-publish-remediation-install-gh';
        case 'use-managed-gh':
            return 'scm-publish-remediation-use-managed-gh';
        case 'authenticate-gh':
            return 'scm-publish-remediation-authenticate-gh';
        case 'open-browser':
            return 'scm-publish-remediation-open-browser';
    }
}

function getPublishRemediationActionLabel(action: SourceControlPublishRemediationAction): string {
    switch (action.kind) {
        case 'connect-github':
            return t('files.sourceControlOperations.update.publishRepository.remediation.connectGitHub');
        case 'install-gh':
            return t('files.sourceControlOperations.update.publishRepository.remediation.installGh');
        case 'use-managed-gh':
            return t('files.sourceControlOperations.update.publishRepository.remediation.useManagedGh');
        case 'authenticate-gh':
            return t('files.sourceControlOperations.update.publishRepository.remediation.authenticateGh');
        case 'open-browser':
            return t('files.sourceControlOperations.update.publishRepository.remediation.openBrowser');
    }
}
