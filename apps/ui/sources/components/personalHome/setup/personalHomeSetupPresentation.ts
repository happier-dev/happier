import { resolveCliAcquisitionFailureMessage } from '@/components/systemTasks/cliAcquisitionPresentation';
import { presentThisComputerConnection } from '@/components/settings/machines/localControl/thisComputerConnectionPresentation';
import { t, tLoose } from '@/text';

import type { PersonalHomeBootstrapSnapshot } from '../bootstrap/personalHomeBootstrapTypes';

/**
 * What the setup surface says in each state of the canonical bootstrap snapshot: one heading and one
 * status line, never the same sentence twice. It decides nothing about the lifecycle; the snapshot's
 * `phase`, `action` and typed `detail.code` already did.
 */
export type PersonalHomeSetupPresentation =
  | Readonly<{ kind: 'working'; title: string; status: string }>
  | Readonly<{ kind: 'ready'; title: string; status: string }>
  | Readonly<{
      kind: 'choice';
      choice:
        | 'existing-runtime'
        | 'existing-runtime-credentials'
        | 'signed-in-home';
      title: string;
      status: string;
    }>
  | Readonly<{
      kind: 'failure';
      /** `use-existing` runs the "Use this local Home" choice again; `setup` retries the setup operation. */
      retry: 'setup' | 'use-existing';
      retryLabel: string;
      title: string;
      status: string;
    }>;

/**
 * Only translated copy keyed by the typed code reaches the status line: `detail.message` is a
 * diagnostic that may carry credentials and is shown, sanitized, only inside Details.
 */
function reasonCopy(code: string | undefined): string | null {
  if (!code) return null;
  const acquisitionFailure = resolveCliAcquisitionFailureMessage(code);
  if (acquisitionFailure) return acquisitionFailure;
  const key = `personalHome.bootstrap.blocked.${code}`;
  const value = tLoose(key);
  return typeof value === 'string' && value !== key ? value : null;
}

function workingStatus(phase: PersonalHomeBootstrapSnapshot['phase']): string {
  switch (phase) {
    case 'checking':
      return t('personalHome.bootstrap.checkingStatus');
    case 'preparing-computer':
      return t('personalHome.bootstrap.preparingComputerStatus');
    default:
      return t('personalHome.bootstrap.ensuringHomeStatus');
  }
}

export function presentPersonalHomeSetup(
  snapshot: PersonalHomeBootstrapSnapshot,
): PersonalHomeSetupPresentation {
  if (snapshot.phase === 'ready') {
    return {
      kind: 'ready',
      title: t('personalHome.bootstrap.setupState.readyTitle'),
      status: t('personalHome.bootstrap.setupState.readyStatus'),
    };
  }
  if (snapshot.phase !== 'blocked') {
    return {
      kind: 'working',
      title: t('personalHome.bootstrap.title'),
      status: workingStatus(snapshot.phase),
    };
  }

  const code = snapshot.detail?.code?.trim();
  if (snapshot.action === 'choose-signed-in-home') {
    return {
      kind: 'choice',
      choice: 'signed-in-home',
      title: t('personalHome.bootstrap.setupState.signedInTitle'),
      status: t('personalHome.bootstrap.signedInHome.body', {
        home: snapshot.signedInHomeLabel ?? '',
      }),
    };
  }
  if (snapshot.action === 'choose-existing-runtime') {
    if (code === 'existing_runtime_credentials') {
      return {
        kind: 'choice',
        choice: 'existing-runtime-credentials',
        title: t('personalHome.bootstrap.setupState.credentialsTitle'),
        status: t('personalHome.bootstrap.existingRuntimeCredentials.body'),
      };
    }
    // "Use this local Home" failed. The two endpoint reasons the controller types get their own words; the
    // controller exposes no update operation here, so "older version" says where the update lives instead of
    // offering a button that could not run it.
    if (code === 'personal_home_endpoint_update_required') {
      return {
        kind: 'failure',
        retry: 'use-existing',
        retryLabel: t('common.retry'),
        title: t('personalHome.bootstrap.setupState.endpointUpdateRequiredTitle'),
        status: t('personalHome.bootstrap.setupState.endpointUpdateRequiredStatus'),
      };
    }
    if (code === 'personal_home_endpoint_unreachable') {
      return {
        kind: 'failure',
        retry: 'use-existing',
        retryLabel: t('common.retry'),
        title: t('personalHome.bootstrap.setupState.endpointUnreachableTitle'),
        status: t('personalHome.bootstrap.setupState.endpointUnreachableStatus'),
      };
    }
    if (snapshot.detail?.retryable === true) {
      return {
        kind: 'failure',
        retry: 'use-existing',
        retryLabel: t('common.retry'),
        title: t(
          'personalHome.bootstrap.setupState.existingRuntimeFailedTitle',
        ),
        status:
          reasonCopy(code) ??
          t('personalHome.bootstrap.setupState.existingRuntimeFailedStatus'),
      };
    }
    return {
      kind: 'choice',
      choice: 'existing-runtime',
      title: t('personalHome.bootstrap.setupState.existingRuntimeTitle'),
      status: t('personalHome.bootstrap.setupState.existingRuntimeStatus'),
    };
  }

  const computer = snapshot.detail?.thisComputer
    ? presentThisComputerConnection(snapshot.detail.thisComputer)
    : null;
  if (computer) {
    return {
      kind: 'failure',
      retry: 'setup',
      retryLabel: computer.actionLabel,
      title: computer.title,
      status: computer.description,
    };
  }
  if (code === 'personal_home_erased') {
    return {
      kind: 'failure',
      retry: 'setup',
      retryLabel: t('personalHome.bootstrap.setupState.erasedAction'),
      title: t('personalHome.bootstrap.setupState.erasedTitle'),
      status: t('personalHome.bootstrap.blockedBody.personal_home_erased'),
    };
  }
  return {
    kind: 'failure',
    retry: 'setup',
    retryLabel: t('common.retry'),
    title: t('personalHome.bootstrap.setupState.failureTitle'),
    status: reasonCopy(code) ?? t('personalHome.bootstrap.failureBody'),
  };
}
