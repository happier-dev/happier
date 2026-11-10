import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import type { MachineSetupPreparedReview } from './MachineSetupPlanReview';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
afterEach(() => standardCleanup());

const { MachineSetupPlanReview } = await import('./MachineSetupPlanReview');

it('names the refused setup target and keeps its typed reason in the error presented to the person', async () => {
  const { describeMachineSetupPlanFailure } = await import('./MachineSetupPlanReview');
  const description = describeMachineSetupPlanFailure({ ok: false, errorCode: 'permission_denied',
    error: 'Machine access was refused.', details: { target: { homeId: 'home', machineId: 'shop' } } },
  id => id === 'shop' ? 'shop-prod' : id);
  expect(description).toContain('shop-prod');
  expect(description).toContain('permission_denied');
  expect(description).toContain('Machine access was refused.');
});

const target = (machineId: string) => ({
  homeId: 'home',
  machineId,
  sources: [],
  desiredRevision: 1,
  recipePlans: [],
});
const names: Record<string, string> = {
  vps: 'vps-1',
  shop: 'shop-prod',
  nl2: 'nl2',
};
type Screen = Awaited<ReturnType<typeof renderScreen>>;
// The composite row that owns the testID (its host children repeat the id without row props).
const row = (screen: Screen, testID: string) =>
  screen.tree.findAll(
    (node) =>
      node.props?.testID === testID && typeof node.props.title === 'string',
  )[0]?.props as { title: string; subtitle?: string; detail?: string } | undefined;

describe('MachineSetupPlanReview', () => {
  it('shows the exact reviewed recipe script and its check in the shared approval surface', async () => {
    const { MachineSetupApplyInputV1Schema } = await import('@happier-dev/protocol/machines/managed/actionsV1');
    const body = '#!/bin/bash\nprintf "%s" "$HOME"\n';
    const checkBody = 'test -e /example/vendor\n';
    const selection = { ref: { pluginId: 'example.software', recipeId: 'installer', revision: '1' }, inputs: {} };
    const prepared: MachineSetupPreparedReview = { ok: true,
      input: MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'vps', targets: [{ ...target('vps'),
        sources: [{ kind: 'direct', setup: { items: [{ kind: 'setupRecipe', selection }] } }],
        recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: { v: 1,
          basis: { kind: 'setup', machineId: 'vps', desiredRevision: 1, selection },
          steps: [{ id: 'installer', kind: 'script', shell: 'bash', body,
            check: { body: checkBody, unsatisfiedExitCodes: [1] } }],
          nativeFacts: [{ stepId: 'installer', status: 'drifted', facts: {} }], planDigest: 'a'.repeat(64),
        } }],
      }] }), facts: [{ homeId: 'home', machineId: 'vps', support: [] }],
    };
    const screen = await renderScreen(<MachineSetupPlanReview testID="review" prepared={prepared} nameOf={id => names[id] ?? id} />);
    await act(async () => { await screen.pressByTestId('review.changes.commands'); });
    // The text-content convenience helper collapses whitespace; inspect the
    // rendered text operand to prove newlines and shell bytes survive intact.
    expect(screen.tree.findAll(node => node.props?.children === body).length).toBeGreaterThan(0);
    expect(screen.tree.findAll(node => node.props?.children === checkBody).length).toBeGreaterThan(0);
    await screen.unmount();
  });
  it('reviews a removal input as one named removal without counting retained scripts or toolchain', async () => {
    const { MachineSetupRemoveInputV1Schema } = await import('@happier-dev/protocol/machines/managed/actionsV1');
    const prepared = { ok: true as const, input: MachineSetupRemoveInputV1Schema.parse({
      homeId: 'home', machineId: 'vps', desiredRevision: 1,
      sources: [{ kind: 'direct', setup: { toolchain: { adapterId: 'mise', config: '[tools]' }, scripts: [{ body: 'echo retained' }] } }],
      removeItemKeys: ['owned'], removalPlans: [{ itemKey: 'owned', plan: { v: 1,
        basis: { kind: 'setup', machineId: 'vps', desiredRevision: 1, selection: {
          ref: { pluginId: 'example.software', recipeId: 'owned', revision: '1' }, inputs: {} } },
        steps: [{ id: 'remove', kind: 'command', executable: 'rm', args: ['--', 'owned'],
          check: { executable: 'test', args: ['!', '-e', 'owned'], unsatisfiedExitCodes: [1] } }],
        nativeFacts: [{ stepId: 'remove', status: 'drifted', facts: { exitCode: 1 } }], planDigest: 'a'.repeat(64),
      } }],
    }), facts: [{ homeId: 'home', machineId: 'vps', support: [] }] };
    const screen = await renderScreen(<MachineSetupPlanReview testID="review" prepared={prepared} nameOf={(id) => names[id] ?? id} />);
    const { t } = await import('@/text');
    expect(row(screen, 'review.target.vps')?.detail).toBe(t('machinePresets.setup.review.changes', { count: 1 }));
    await act(async () => { await screen.pressByTestId('review.changes.commands'); });
    expect(screen.getTextContent()).toContain('$ rm -- owned');
    expect(screen.getTextContent()).not.toContain('echo retained');
    expect(screen.tree.findAll(node => node.props?.testID === 'review.changes.files')).toHaveLength(0);
    await screen.unmount();
  });

  it('shows a direct Mise-only Plan as a change and discloses its exact config in the shared review', async () => {
    const config = '[tools]\nnode = "22.14.0"';
    const prepared: MachineSetupPreparedReview = {
      ok: true,
      input: { homeId: 'home', machineId: 'vps', targets: [{ ...target('vps'), desiredRevision: 0,
        sources: [{ kind: 'direct', setup: { toolchain: { adapterId: 'mise', config } } }],
      }] },
      facts: [{ homeId: 'home', machineId: 'vps', support: [] }],
    };
    const screen = await renderScreen(<MachineSetupPlanReview testID="review" prepared={prepared} nameOf={(id) => names[id] ?? id} />);
    const { t } = await import('@/text');
    expect(row(screen, 'review.target.vps')?.detail).toBe(t('machinePresets.setup.review.changes', { count: 1 }));
    await act(async () => { await screen.pressByTestId('review.changes.files'); });
    expect(screen.getTextContent()).toContain(`mise · ${config}`);
    await screen.unmount();
  });

  it('states each reported fact per Machine and keeps unreported ones unknown, never safe', async () => {
    const prepared = {
      ok: true,
      input: {
        homeId: 'home',
        machineId: 'nl2',
        targets: [target('vps'), target('shop')],
      },
      review: {
        machineId: 'nl2',
        machines: [
          { machineId: 'nl2', online: true },
          { machineId: 'vps', online: true },
        ],
      },
      facts: [
        {
          homeId: 'home',
          machineId: 'vps',
          support: [{ sourceIndex: 0, itemIndex: 0, status: 'unsupported' }],
          review: {
            target: { homeId: 'home', machineId: 'vps' },
            administratorRequired: true,
            downtime: 'none',
          },
        },
        // shop-prod's daemon reported no review facts at all.
        {
          homeId: 'home',
          machineId: 'shop',
          support: [{ sourceIndex: 0, itemIndex: 0, status: 'unverifiable' }],
        },
      ],
    } as MachineSetupPreparedReview;
    const screen = await renderScreen(
      <MachineSetupPlanReview
        testID="review"
        prepared={prepared}
        nameOf={(id) => names[id] ?? id}
        onChangeHost={vi.fn()}
      />,
    );
    const { t } = await import('@/text');
    // One labelled row per fact; each answer names the Machines it holds for, an unreported one says who.
    const administrator = row(screen, 'review.administrator');
    expect(administrator?.title).toBe(t('machinePresets.setup.review.administrator'));
    expect(administrator?.subtitle).toContain(`${t('machinePresets.setup.review.adminNeeded')} · vps-1`);
    expect(administrator?.subtitle).toContain(`${t('machinePresets.setup.review.unknown')} · ${t('machinePresets.setup.review.notReported', { machines: 'shop-prod' })}`);
    expect(administrator?.subtitle).not.toContain(t('machinePresets.setup.review.adminNotNeeded'));
    const downtime = row(screen, 'review.downtime');
    expect(downtime?.subtitle).toContain(`${t('machinePresets.setup.review.downtimeNone')} · vps-1`);
    expect(downtime?.subtitle).toContain(t('machinePresets.setup.review.unknown'));
    // Per-item support is counted on its own Machine, not merged into a fleet claim.
    expect(row(screen, 'review.target.vps')?.subtitle).toBeTruthy();
    expect(row(screen, 'review.target.shop')?.subtitle).not.toBe(
      row(screen, 'review.target.vps')?.subtitle,
    );
    expect(screen.getTextContent()).toContain('nl2');
    await screen.unmount();
  });

  it('says what this setup does with each app, deploying only new ones, and keeps left-out items', async () => {
    const app = (name: string, version: string) => ({
      kind: 'app',
      definition: {
        name,
        project: { kind: 'create' },
        definition: {
          from: 'catalogApp',
          templateRef: { sourceId: 'catalog', itemId: name, ref: { version } },
        },
        bindings: [],
      },
    });
    const source = {
      kind: 'accountPreset',
      presetId: 'web',
      presetRevision: 3,
      setup: {
        items: [
          app('Plausible', '2'),
          app('Uptime Kuma', '2'),
          app('Grafana', '1'),
          app('Metabase', '1'),
          app('Gitea', '1'),
          app('Umami', '1'),
        ],
      },
    };
    const prepared = {
      ok: true,
      input: {
        homeId: 'home',
        machineId: 'vps',
        targets: [{ ...target('vps'), sources: [source] }],
      },
      facts: [
        {
          homeId: 'home',
          machineId: 'vps',
          support: [],
          // Uptime Kuma was deployed from version 1; this preset now names version 2.
          sourceFacts: {
            'account:web': {
              acceptedAppRuns: [
                { intent: app('Uptime Kuma', '1').definition, homeId: 'home', runId: 'run', sourceKey: 's', blockId: 'b', actionId: 'deployments.deploy' },
                { intent: app('Umami', '1').definition, homeId: 'home', runId: 'run', sourceKey: 's', blockId: 'b', actionId: 'deployments.deploy' },
              ],
            },
          },
          removalOffers: [
            { itemKey: 'a', status: 'eligible', selected: false, item: { kind: 'softwareRecipe', selection: { ref: { pluginId: 'p', recipeId: 'r', revision: '1' }, inputs: {} } } },
            { itemKey: 'b', status: 'notEligible', selected: false, reason: 'preExisting', item: { kind: 'softwareRecipe', selection: { ref: { pluginId: 'p', recipeId: 'q', revision: '1' }, inputs: {} } } },
          ],
          review: {
            target: { homeId: 'home', machineId: 'vps' },
            administratorRequired: false,
            downtime: 'unknown',
            apps: [
              { sourceIndex: 0, itemIndex: 0, kind: 'new' },
              { sourceIndex: 0, itemIndex: 1, kind: 'completed', environmentId: 'env-kuma' },
              { sourceIndex: 0, itemIndex: 2, kind: 'not_completed' },
              { sourceIndex: 0, itemIndex: 3, kind: 'failed' },
              { sourceIndex: 0, itemIndex: 4, kind: 'unknown' },
              { sourceIndex: 0, itemIndex: 5, kind: 'completed' },
            ],
          },
        },
      ],
    } as unknown as MachineSetupPreparedReview;
    const screen = await renderScreen(
      <MachineSetupPlanReview
        testID="review"
        prepared={prepared}
        nameOf={(id) => names[id] ?? id}
      />,
    );
    const { t } = await import('@/text');
    const appRow = (index: number) => row(screen, `review.app.vps.0.${index}`);
    // Each app by its own name, with what this setup does to it; only a new one deploys.
    expect(appRow(0)).toMatchObject({ title: 'Plausible', detail: t('machinePresets.setup.review.appNew') });
    expect(appRow(1)?.detail).toBe(t('machinePresets.setup.review.appDeployed'));
    // A deployed app whose pin changed keeps its version; an unchanged one simply stays.
    expect(appRow(1)?.subtitle).toBe(t('machinePresets.setup.review.appPinChanged'));
    expect(appRow(5)?.subtitle).toBe(t('machinePresets.setup.review.appStays'));
    expect(appRow(2)?.detail).toBe(t('machinePresets.setup.review.appStillDeploying'));
    expect(appRow(3)?.detail).toBe(t('machinePresets.setup.review.appFailed'));
    // An app whose state couldn't be read is "Not known" and isn't deployed, never assumed new.
    expect(appRow(4)?.detail).toBe(t('machinePresets.setup.review.unknown'));
    expect(appRow(4)?.subtitle).toBe(t('machinePresets.setup.review.appUnknown', { machine: 'vps-1' }));
    // Items the preset no longer has stay on the Machine (removal starts unticked), each as its own row.
    expect(row(screen, 'review.remove.vps.a')?.subtitle).toBe(t('machinePresets.setup.review.removeStays'));
    expect(row(screen, 'review.remove.vps.b')?.subtitle).toBe(t('machinePresets.setup.review.removeNotEligible.preExisting'));
    // Downtime the Machine reported as unknown reads "Not known", not "None".
    expect(row(screen, 'review.downtime')?.subtitle).toBe(t('machinePresets.setup.review.unknown'));
    await screen.unmount();
  });

  it('lists the apps of a Machine that reported nothing about them as not known, never as new', async () => {
    const source = {
      kind: 'direct',
      setup: {
        items: [
          {
            kind: 'app',
            definition: {
              name: 'Plausible',
              project: { kind: 'create' },
              definition: { from: 'catalogApp', templateRef: { sourceId: 'catalog', itemId: 'plausible', ref: { version: '2' } } },
              bindings: [],
            },
          },
        ],
      },
    };
    const prepared = {
      ok: true,
      input: { homeId: 'home', machineId: 'vps', targets: [{ ...target('vps'), sources: [source] }] },
      // An older daemon: no review at all, so nothing about its apps.
      facts: [{ homeId: 'home', machineId: 'vps', support: [] }],
    } as unknown as MachineSetupPreparedReview;
    const screen = await renderScreen(
      <MachineSetupPlanReview testID="review" prepared={prepared} nameOf={(id) => names[id] ?? id} />,
    );
    const { t } = await import('@/text');
    expect(row(screen, 'review.app.vps.0.0')).toMatchObject({
      title: 'Plausible',
      detail: t('machinePresets.setup.review.unknown'),
      subtitle: t('machinePresets.setup.review.notReported', { machines: 'vps-1' }),
    });
    await screen.unmount();
  });

  it('breaks down what changes by kind, only for steps not already in place, and counts removals', async () => {
    const plan = (steps: unknown[], satisfied: number[] = []) => ({
      v: 1, basis: { kind: 'setup' }, planDigest: 'd'.repeat(64), steps,
      nativeFacts: steps.map((step, index) => ({ stepId: (step as { id: string }).id, status: satisfied.includes(index) ? 'satisfied' : 'unsatisfied' })),
    });
    const prepared = {
      ok: true,
      input: { homeId: 'home', machineId: 'vps', targets: [{ ...target('vps'), removeItemKeys: ['old'],
        recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: plan([
          { id: 'p', kind: 'package', manager: 'apt', packages: [{ name: 'docker-ce', version: '27.3' }, { name: 'docker-compose-plugin' }] },
          { id: 'f', kind: 'file', path: '/etc/docker/daemon.json', content: { kind: 'literal', value: '{}' } },
          { id: 'g', kind: 'group', name: 'docker', members: ['happier'] },
          { id: 'w', kind: 'firewall', rules: 'x', exposures: [
            { requirementId: 'ssh', hostAddress: '0.0.0.0', hostPort: 22, protocol: 'tcp', exposure: 'public' },
            { requirementId: 'web', hostAddress: '0.0.0.0', hostPort: 443, protocol: 'tcp', exposure: 'public' },
          ] },
          { id: 's', kind: 'serviceUnit', unit: 'docker.service', enabled: true, running: true },
          { id: 'c', kind: 'command', executable: 'corepack', args: ['enable'], check: { executable: 'corepack', args: ['-v'], unsatisfiedExitCodes: [1] } },
          // Already in place: not a change.
          { id: 'f2', kind: 'file', path: '/etc/motd', content: { kind: 'literal', value: 'hi' } },
        ], [6]) }],
        removalPlans: [{ itemKey: 'old', plan: plan([{ id: 'r', kind: 'package', manager: 'apt', state: 'absent', packages: [{ name: 'caddy' }] }]) }],
      }] },
      facts: [{ homeId: 'home', machineId: 'vps', support: [] }],
    } as unknown as MachineSetupPreparedReview;
    const screen = await renderScreen(
      <MachineSetupPlanReview testID="review" prepared={prepared} nameOf={(id) => names[id] ?? id} />,
    );
    const { t } = await import('@/text');
    // Packages count their packages; the other pending steps and chosen removal
    // count once each. The file already in place contributes no change.
    expect(row(screen, 'review.target.vps')?.detail).toBe(t('machinePresets.setup.review.changes', { count: 8 }));
    expect(row(screen, 'review.changes.packages')).toMatchObject({
      title: t('machinePresets.setup.review.changeKinds.packages'),
      detail: `${t('machinePresets.setup.review.toInstall', { count: 2 })} · ${t('machinePresets.setup.review.toRemove', { count: 1 })}`,
    });
    expect(row(screen, 'review.changes.files')?.detail).toBe(t('machinePresets.setup.review.changes', { count: 1 }));
    // Each kind opens to the exact operands the Machine will act on.
    for (const kind of ['packages', 'files', 'services']) await act(async () => { await screen.pressByTestId(`review.changes.${kind}`); });
    const text = screen.getTextContent();
    expect(text).toContain('apt · docker-ce 27.3');
    expect(text).toContain('happier → docker');
    expect(text).toContain('docker.service');
    expect(text).toContain('corepack enable');
    expect(text).not.toContain('/etc/motd');
    // Ports say what is reachable from outside afterwards.
    expect(text).toContain(t('machinePresets.setup.review.fromOutside', { ports: '22 and 443' }));
    await screen.unmount();
  });

  it('lists a change several Machines share once, names a Machine only for its own changes, and counts packages, not sources', async () => {
    const plan = (steps: unknown[]) => ({
      v: 1, basis: { kind: 'setup' }, planDigest: 'd'.repeat(64), steps,
      nativeFacts: steps.map((step) => ({ stepId: (step as { id: string }).id, status: 'unsatisfied' })),
    });
    const shared = [
      { id: 'src', kind: 'packageSource', manager: 'apt', path: '/etc/apt/sources.list.d/docker.list', keyPath: '/etc/apt/keyrings/docker.gpg',
        url: 'https://download.docker.com/linux/ubuntu', suite: 'noble', components: ['stable'], architectures: ['amd64'],
        keyUrl: 'https://download.docker.com/linux/ubuntu/gpg', keyFingerprint: '9DC858229FC7DD38854AE2D88D81803C0EBFCD88' },
      { id: 'p', kind: 'package', manager: 'apt', packages: [{ name: 'docker-ce' }, { name: 'docker-ce-cli' }] },
      { id: 'g', kind: 'group', name: 'docker', members: ['happier'] },
    ];
    const prepared = {
      ok: true,
      input: { homeId: 'home', machineId: 'vps', targets: [
        { ...target('vps'), recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: plan(shared) }] },
        { ...target('shop'), recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: plan([...shared,
          { id: 'c', kind: 'command', executable: 'corepack', args: ['enable'], check: { executable: 'corepack', args: ['-v'], unsatisfiedExitCodes: [1] } }]) }] },
      ] },
      facts: ['vps', 'shop'].map((machineId) => ({ homeId: 'home', machineId, support: [],
        review: { target: { homeId: 'home', machineId }, administratorRequired: true, downtime: 'none' } })),
    } as unknown as MachineSetupPreparedReview;
    const screen = await renderScreen(
      <MachineSetupPlanReview testID="review" prepared={prepared} nameOf={(id) => names[id] ?? id} />,
    );
    const { t } = await import('@/text');
    // Two packages to install; the source they come from is listed but isn't a package.
    expect(row(screen, 'review.changes.packages')?.detail).toBe(t('machinePresets.setup.review.toInstall', { count: 2 }));
    // The group change both Machines make reads once, with no names; the command only shop-prod runs names it.
    expect(row(screen, 'review.changes.users')?.detail).toBe(t('machinePresets.setup.review.changes', { count: 1 }));
    const text = screen.getTextContent();
    expect(text.split('happier → docker')).toHaveLength(2);
    expect(text).not.toContain('happier → docker · ');
    expect(text).toContain('corepack enable · shop-prod');
    // One answer for every Machine reads without the list of names.
    expect(row(screen, 'review.administrator')?.subtitle).toBe(t('machinePresets.setup.review.adminNeeded'));
    expect(row(screen, 'review.downtime')?.subtitle).toBe(t('machinePresets.setup.review.downtimeNone'));
    await screen.unmount();
  });

  it('lets the person choose which left-out items to remove, by recipe name, and re-plans with that choice', async () => {
    const ref = (recipeId: string) => ({ pluginId: 'p', recipeId, revision: '1' });
    const offer = (itemKey: string, recipeId: string, rest: Record<string, unknown>) => ({
      itemKey, item: { kind: 'softwareRecipe', selection: { ref: ref(recipeId), inputs: {} } }, ...rest });
    const prepared = {
      ok: true,
      input: { homeId: 'home', machineId: 'vps', targets: [{ ...target('vps'), removeItemKeys: ['b'] }] },
      facts: [{ homeId: 'home', machineId: 'vps', support: [],
        recipeTitles: [{ ref: ref('docker'), title: 'Docker' }, { ref: ref('caddy'), title: 'Caddy' }, { ref: ref('git'), title: 'Git' }],
        removalOffers: [
          offer('a', 'docker', { status: 'eligible', selected: false }),
          offer('b', 'caddy', { status: 'eligible', selected: true }),
          offer('c', 'git', { status: 'notEligible', selected: false, reason: 'unknownOrigin' }),
        ] }],
    } as unknown as MachineSetupPreparedReview;
    const onChangeRemoval = vi.fn();
    const screen = await renderScreen(
      <MachineSetupPlanReview testID="review" prepared={prepared} nameOf={(id) => names[id] ?? id} onChangeRemoval={onChangeRemoval} />,
    );
    const { t } = await import('@/text');
    expect(row(screen, 'review.remove.vps.a')).toMatchObject({ title: 'Docker', subtitle: t('machinePresets.setup.review.removeStays') });
    expect(row(screen, 'review.remove.vps.b')).toMatchObject({ title: 'Caddy', subtitle: t('machinePresets.setup.review.removeChosen') });
    expect(row(screen, 'review.remove.vps.c')).toMatchObject({ title: 'Git', subtitle: t('machinePresets.setup.review.removeNotEligible.unknownOrigin') });
    // Choosing Docker re-plans this Machine with both removals; the not-eligible one has no control.
    const toggle = screen.tree.findAll((node) => node.props?.testID === 'review.remove.vps.a.switch' && typeof node.props.onValueChange === 'function')[0];
    expect(toggle).toBeTruthy();
    toggle!.props.onValueChange(true);
    expect(onChangeRemoval).toHaveBeenCalledWith('vps', ['b', 'a']);
    expect(screen.tree.findAll((node) => node.props?.testID === 'review.remove.vps.c.switch')).toHaveLength(0);
    await screen.unmount();
  });

  it('says where it runs is unknown when no host was reported', async () => {
    const prepared = {
      ok: true,
      input: { homeId: 'home', machineId: 'vps', targets: [target('vps')] },
      facts: [
        {
          homeId: 'home',
          machineId: 'vps',
          support: [],
          review: {
            target: { homeId: 'home', machineId: 'vps' },
            administratorRequired: false,
            downtime: 'possible',
          },
        },
      ],
    } as MachineSetupPreparedReview;
    const screen = await renderScreen(
      <MachineSetupPlanReview
        testID="review"
        prepared={prepared}
        nameOf={(id) => names[id] ?? id}
        onChangeHost={vi.fn()}
      />,
    );
    const { t } = await import('@/text');
    // One Machine: its answer needs no name beside it.
    expect(row(screen, 'review.administrator')?.subtitle).toBe(
      t('machinePresets.setup.review.adminNotNeeded'),
    );
    expect(row(screen, 'review.downtime')?.subtitle).toBe(
      t('machinePresets.setup.review.downtimePossible'),
    );
    expect(row(screen, 'review.host')).toMatchObject({
      title: t('machinePresets.setup.review.runsOn'),
      subtitle: t('machinePresets.setup.review.unknown'),
    });
    await screen.unmount();
  });

  it('names each offline Machine it leaves out by Home and Machine, beside the ones it sets up (SOFTWARE-OFFLINE)', async () => {
    const prepared = {
      ok: true,
      input: { homeId: 'home', machineId: 'vps', targets: [target('vps')] },
      facts: [{ homeId: 'home', machineId: 'vps', support: [] }],
      unavailableTargets: [
        { homeId: 'home', machineId: 'shop', status: 'unavailable', reason: 'offline', errorCode: 'machine_offline' },
      ],
    } as MachineSetupPreparedReview;
    const screen = await renderScreen(
      <MachineSetupPlanReview testID="review" prepared={prepared} nameOf={(id) => names[id] ?? id} />,
    );
    const { t } = await import('@/text');
    const { resolveHomeDisplayLabelForServerIdentity } = await import('@/components/settings/server/homeDisplayName');
    const home = resolveHomeDisplayLabelForServerIdentity('home');
    // The offline Machine is a row of its own under Machines: its name, its Home and native offline reason, and "Left out".
    expect(row(screen, 'review.unavailable.home.shop')).toMatchObject({
      title: 'shop-prod',
      subtitle: t('machinePresets.setup.review.leftOutOffline', { home }),
      detail: t('machinePresets.setup.review.leftOut'),
    });
    // The Machine it sets up keeps its own row and count; nothing waits for the offline one.
    expect(row(screen, 'review.target.vps')?.title).toBe('vps-1');
    await screen.unmount();
  });

  it('says which Machines were offline when none could be planned, and nothing for any other failure', async () => {
    const { describeMachineSetupAllOffline } = await import('./MachineSetupPlanReview');
    const { t } = await import('@/text');
    const offline = (machineId: string) => ({ homeId: 'home', machineId, status: 'unavailable', reason: 'offline', errorCode: 'machine_offline' });
    expect(describeMachineSetupAllOffline({ ok: false, errorCode: 'machine_offline', error: 'machine_offline',
      details: { targets: [offline('vps'), offline('shop')] } }, (id) => names[id] ?? id))
      .toBe(t('machinePresets.setup.review.allOffline', { machines: 'vps-1, shop-prod' }));
    expect(describeMachineSetupAllOffline({ ok: false, errorCode: 'plan_changed', error: 'plan_changed' }, (id) => id)).toBeNull();
  });
});
