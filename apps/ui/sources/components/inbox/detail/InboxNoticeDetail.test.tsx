import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { AgentActionButton } from '@happier-dev/plugin-ui/components';

const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router }).module;
});

afterEach(() => {
  standardCleanup();
  router.push.mockReset();
});

const { InboxNoticeDetail } = await import('./InboxItemDetail');

const selection = {
  configuredActionId: 'investigate', sessionChoice: { kind: 'configured' as const },
  agentChoice: { kind: 'configured' as const }, delivery: 'configured' as const,
};

function render(answer: ActionExecuteResult | ((call: number, options: unknown, delivery: unknown) => ActionExecuteResult)) {
  let call = 0;
  return renderScreen(
    <InboxNoticeDetail
      title="checkout-api is failing its health check"
      body="Docker’s health check has failed since 11:02."
      source="Service health"
      createdAt={Date.now() - 60_000}
      serverId="home-a"
      onDismiss={async () => {}}
      subject={{ kind: 'service', machineId: 'machine-1', service: 'checkout-api', open: true, investigable: true }}
      investigation={{
        readChoices: async () => ({ v: 1, kind: 'choices', defaultActionId: 'investigate', actions: [{ label: 'Investigate', launchMode: 'start', selection }] }),
        resume: () => null,
        run: async (selection, options) => typeof answer === 'function' ? answer(call++, options, selection.delivery) : answer,
      }}
    />,
  );
}

describe('Inbox notice detail: the way to the cause (COR5B #162 "1 of 1 servers down")', () => {
  const environment = { serverId: 'home-a', projectSourceId: 'source-1', environmentId: 'env-1' };
  const header = (page: Record<string, unknown>) => ({ kind: 'account_notice.v1', source: { kind: 'host', topic: 'service_health' },
    page: { kind: 'host', ...page } }) as unknown as Parameters<typeof resolveInboxNoticeSubjectRoute>[0];
  let resolveInboxNoticeSubjectRoute: typeof import('../inboxItemFocus')['resolveInboxNoticeSubjectRoute'];

  it('resolves a health notice to its Environment or its service on the Machine, never to a raw id line', async () => {
    ({ resolveInboxNoticeSubjectRoute } = await import('../inboxItemFocus'));
    expect(resolveInboxNoticeSubjectRoute(header({ page: 'environment', environment }))).toContain('env-1');
    const service = { kind: 'adopted', machineId: 'machine-1', serviceId: 'svc-1' };
    const href = resolveInboxNoticeSubjectRoute(header({ page: 'machine_service', machine: { serverId: 'home-a', machineId: 'machine-1' }, service }));
    expect(href).toContain('machine-1');
    expect(href).toContain('svc-1');
    expect(resolveInboxNoticeSubjectRoute(undefined)).toBeNull();
  });

  it('opens the Environment from the notice and offers its recovery choices through the notice owner', async () => {
    const entry = { artifact: { id: 'notice-1' } } as never;
    const runRecoveryChoice = vi.fn(async () => ({ ok: true as const }));
    const screen = await renderScreen(
      <InboxNoticeDetail
        title="1 of 1 servers down" body={null} source="Service health" createdAt={Date.now() - 60_000} serverId="home-a"
        onDismiss={async () => {}}
        subject={{ kind: 'environment', environment, open: true, investigable: false }}
        subjectRoute="/deployments/source-1?deploymentEnvironment=env-1"
        recovery={{ entry, binding: {
          readRecoveryChoices: () => [{ label: 'Restart', actionId: 'deployments.restart' }] as never,
          runRecoveryChoice,
        } }}
      />,
    );
    await screen.pressByTestIdAsync('inbox.notice.health.environment');
    expect(router.push).toHaveBeenCalledWith('/deployments/source-1?deploymentEnvironment=env-1');
    expect(screen.findByTestId('inbox.notice.recovery')).not.toBeNull();
    expect(screen.getTextContent()).toContain('Restart');
  });
});

describe('Inbox notice detail', () => {
  it('shows the typed refusal when the Session exists but its input was rejected', async () => {
    const screen = await render({ ok: true, result: { v: 1, handoff: {
      kind: 'sendResult', session: { serverId: 'home-a', sessionId: 'diagnosis' },
      result: { status: 'rejected', code: 'session_input_target_unavailable' },
    } } });
    await act(async () => { await screen.findAllByType(AgentActionButton)[0]!.props.onLaunch('start'); });
    expect(screen.findByTestId('inbox.notice.investigate.unavailable')).not.toBeNull();
    await screen.pressByTestIdAsync('inbox.notice.investigate.unavailable.details');
    expect(screen.getTextContent()).toContain('session_input_target_unavailable');
  });

  it('offers the configured action launch and edit modes and keeps Dismiss secondary', async () => {
    const screen = await render({ ok: true, result: { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } } });
    const button = (testID: string) => screen.findAllByType(RoundButton).find((node) => node.props.testID === testID);
    expect(screen.findAllByType(AgentActionButton)[0]?.props.launchMode).toBe('start');
    expect(button('inbox.notice.dismiss')?.props.display).toBe('secondary');
  });

  it('answers an approval Investigate asked for with the canonical waiting notice and its way to the review', async () => {
    const screen = await render({ ok: true, result: { kind: 'approval_request_created', artifactId: 'artifact-7', actionId: 'action.invoke' } });
    await act(async () => { await screen.findAllByType(AgentActionButton)[0]!.props.onLaunch('start'); });
    expect(screen.findByTestId('inbox.notice.investigate.approval')).not.toBeNull();
    await screen.pressByTestIdAsync('inbox.notice.investigate.approval.open');
    expect(router.push).toHaveBeenCalledWith(expect.stringContaining('/inbox/approvals/artifact-7'));
  });
  it('opens the seeded composer when placement is unresolved without a caller opt-in', async () => {
    const folder = (machineId: string, rootPath: string) => ({ serverId: 'home-a', workspaceId: `ws-${machineId}`, machineId, rootPath });
    const choice = { kind: 'placement_choice_required', reason: 'ambiguous_workspace', candidates: [
      { machine: { serverId: 'home-a', machineId: 'machine-1' }, workspace: folder('machine-1', '/srv/checkout'), reachable: true },
      { machine: { serverId: 'home-a', machineId: 'machine-2' }, workspace: folder('machine-2', '/srv/checkout-b'), reachable: true },
      { machine: { serverId: 'home-a', machineId: 'machine-3' }, reachable: false },
    ], agents: [{ targetKey: 'agent:happier.agent.claude/claude', label: 'Claude Code' }, { targetKey: 'agent:happier.agent.codex/codex', label: 'Codex' }] };
    const deliveries: unknown[] = [];
    const screen = await render((call, _options, delivery) => {
      deliveries.push(delivery);
      return call === 0 ? { ok: true, result: { v: 1, handoff: choice } }
        : { ok: true, result: { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } } };
    });
    await act(async () => { await screen.findAllByType(AgentActionButton)[0]!.props.onLaunch('start'); });
    expect(deliveries).toEqual(['send', 'compose']);
    expect(screen.findByTestId('inbox.notice.investigate.placement')).toBeNull();
  });
});
