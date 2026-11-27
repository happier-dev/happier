import { describe, expect, it } from 'vitest';

import { t, tLoose } from '@/text';

import type { PersonalHomeBootstrapSnapshot } from '../bootstrap/personalHomeBootstrapTypes';
import { presentPersonalHomeSetup } from './personalHomeSetupPresentation';

const working: PersonalHomeBootstrapSnapshot = {
  shouldGateShell: true,
  homeReady: false,
  daemonReady: false,
  phase: 'ensuring-home',
  daemonState: 'not-started',
  action: 'none',
};

function blocked(
  action: PersonalHomeBootstrapSnapshot['action'],
  code: string,
  message = 'raw runtime diagnostic',
  retryable = true,
): PersonalHomeBootstrapSnapshot {
  return {
    ...working,
    phase: 'blocked',
    action,
    detail: { code, message, retryable },
  };
}

describe('presentPersonalHomeSetup', () => {
  it('keeps the setup title only while setup is working, and says each other state in its own heading', () => {
    const workingTitle = t('personalHome.bootstrap.title');
    expect(
      presentPersonalHomeSetup({ ...working, phase: 'checking' }),
    ).toMatchObject({ kind: 'working', title: workingTitle });
    expect(presentPersonalHomeSetup(working)).toMatchObject({
      kind: 'working',
      title: workingTitle,
    });

    const states = [
      presentPersonalHomeSetup({
        ...working,
        phase: 'ready',
        homeReady: true,
        daemonReady: true,
      }),
      presentPersonalHomeSetup(
        blocked('choose-existing-runtime', 'existing_runtime', 'x', false),
      ),
      presentPersonalHomeSetup(
        blocked(
          'choose-existing-runtime',
          'existing_runtime_credentials',
          'x',
          false,
        ),
      ),
      presentPersonalHomeSetup({
        ...blocked('choose-signed-in-home', 'signed_in_other_home', 'x', false),
        signedInHomeLabel: 'Happier Cloud',
      }),
      presentPersonalHomeSetup(
        blocked('choose-existing-runtime', 'existing_runtime_operation_failed'),
      ),
      presentPersonalHomeSetup(blocked('retry', 'personal_home_erased')),
      presentPersonalHomeSetup(blocked('retry', 'bootstrap_operation_failed')),
    ];
    expect(states.map((state) => state.kind)).toEqual([
      'ready',
      'choice',
      'choice',
      'choice',
      'failure',
      'failure',
      'failure',
    ]);
    for (const state of states) {
      expect(state.title).not.toBe(workingTitle);
      // One message per state: the heading and the status line never say the same thing.
      expect(state.status).not.toBe(state.title);
      expect(state.status.length).toBeGreaterThan(0);
    }
    // Each choice and each failure names its own situation.
    expect(new Set(states.map((state) => state.title)).size).toBe(
      states.length,
    );
  });

  it('turns a failed "Use this local Home" into a failure whose retry runs that choice again', () => {
    const failed = presentPersonalHomeSetup(
      blocked(
        'choose-existing-runtime',
        'existing_runtime_operation_failed',
        'Personal Home endpoint is not ready yet.',
      ),
    );
    expect(failed).toMatchObject({ kind: 'failure', retry: 'use-existing' });
    expect(failed.status).not.toContain('endpoint is not ready');

    expect(
      presentPersonalHomeSetup(
        blocked('choose-existing-runtime', 'existing_runtime', 'x', false),
      ),
    ).toMatchObject({ kind: 'choice', choice: 'existing-runtime' });
    expect(
      presentPersonalHomeSetup(
        blocked(
          'choose-existing-runtime',
          'existing_runtime_credentials',
          'x',
          false,
        ),
      ),
    ).toMatchObject({ kind: 'choice', choice: 'existing-runtime-credentials' });
  });

  it('names each typed reason "Use this local Home" fails with, and retries that choice', () => {
    const older = presentPersonalHomeSetup(blocked('choose-existing-runtime', 'personal_home_endpoint_update_required', 'features endpoint omits identity'));
    const silent = presentPersonalHomeSetup(blocked('choose-existing-runtime', 'personal_home_endpoint_unreachable', 'ECONNREFUSED 127.0.0.1:3005'));
    const generic = presentPersonalHomeSetup(blocked('choose-existing-runtime', 'existing_runtime_operation_failed'));
    for (const state of [older, silent]) {
      expect(state).toMatchObject({ kind: 'failure', retry: 'use-existing' });
      expect(state.title).not.toBe(generic.title);
      expect(state.status).not.toBe(generic.status);
    }
    expect(older.title).not.toBe(silent.title);
    expect(older.status).not.toContain('features endpoint');
    expect(silent.status).not.toContain('ECONNREFUSED');
  });

  it('says a setup failure in human words from its typed reason, never the raw diagnostic', () => {
    const unhealthy = presentPersonalHomeSetup(
      blocked('retry', 'runtime_unhealthy', 'launchctl exited 78'),
    );
    expect(unhealthy).toMatchObject({
      kind: 'failure',
      retry: 'setup',
      status: tLoose('personalHome.bootstrap.blocked.runtime_unhealthy'),
    });

    const unknown = presentPersonalHomeSetup(
      blocked('retry', 'credential_write_failed', 'seed=abc'),
    );
    expect(unknown).toMatchObject({
      kind: 'failure',
      status: t('personalHome.bootstrap.failureBody'),
    });

    const erased = presentPersonalHomeSetup(
      blocked('retry', 'personal_home_erased'),
    );
    expect(erased.status).toBe(
      tLoose('personalHome.bootstrap.blockedBody.personal_home_erased'),
    );
    // Retry recreates the Home, so the action says so.
    expect(erased.kind === 'failure' && erased.retryLabel).not.toBe(
      t('common.retry'),
    );
  });

  it("takes this computer's connection fact from its one presenter, including the action that fixes it", () => {
    const state = presentPersonalHomeSetup({
      ...blocked('retry', 'daemon_needs_auth'),
      detail: {
        code: 'daemon_needs_auth',
        message: 'raw',
        retryable: true,
        thisComputer: {
          status: 'daemon_needs_auth',
          homeLabel: 'Personal Home',
          daemonHomeLabel: null,
          appAccountLabel: 'maya',
          daemonAccountLabel: null,
        },
      },
    });
    expect(state).toMatchObject({
      kind: 'failure',
      title: t('machine.thisComputer.title.daemon_needs_auth'),
      retryLabel: t('machine.thisComputer.action.daemon_needs_auth'),
    });
  });
});
