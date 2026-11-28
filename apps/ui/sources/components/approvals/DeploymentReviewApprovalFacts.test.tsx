import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

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
  const { en } = await import('@/text/translations/en');
  const { review, domainFieldHost } = en.projects.deployments;
  return createTextModuleMock({ translate: (key, params) => key === 'projects.deployments.domainFieldHost' ? domainFieldHost
    : key === 'projects.deployments.review.removalDeletesProviderScope' ? review.removalDeletesProviderScope({ scope: String(params?.scope) })
    : key === 'projects.deployments.review.removalDomainStops' ? review.removalDomainStops
    : key === 'projects.deployments.review.removalStepService' ? review.removalStepService({ name: String(params?.name) })
    : key === 'projects.deployments.review.removalStepResource' ? review.removalStepResource({ name: String(params?.name) })
    : key === 'projects.deployments.review.removalStepItsDomain' ? review.removalStepItsDomain
    : key === 'projects.deployments.review.decisionRemoveDomain' ? review.decisionRemoveDomain({ hostname: String(params?.hostname) })
    : key === 'projects.deployments.review.replacesNote'
    ? `${key} ${String(params?.revision)}`
    : key === 'projects.deployments.review.versionStored' ? `Compose revision ${String(params?.revision)}`
    : key === 'projects.deployments.review.decisionPromote' ? `Promote ${String(params?.version)} to ${String(params?.environment)}`
    : key === 'projects.deployments.review.railwayVolumeWillKeep' ? `${key} ${params?.count}`
    : key === 'projects.deployments.review.folderContents'
        ? `${params?.count} files · ${params?.size}` : key });
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { DeploymentReviewApprovalFacts, describeDeploymentReviewDecision, readDeploymentReviewApproval,
  readDeploymentEnvironmentUpdateApproval, describeDeploymentEnvironmentUpdateFields, describeDeploymentEnvironmentUpdateDecision,
  readDeploymentPreviewCreateApproval, describeDeploymentPreviewCreateFields, describeDeploymentPreviewCreateDecision } = await import('./DeploymentReviewApprovalFacts');


const { ApprovalIncludedSteps, readApprovalIncludedSteps } = await import('./ApprovalIncludedSteps');

const initialState = storage.getState();
afterEach(() => {
  standardCleanup();
  storage.setState(initialState, true);
});

const machineReview = {
  inspection: 'complete' as const,
  services: [
    { name: 'web', replicas: 1, resources: { cpus: null, memory: null }, restartPolicy: 'unless-stopped', healthcheck: 'configured' as const,
      ports: [], mounts: [] },
  ],
  risks: [{ kind: 'privileged' as const, service: 'web' }, { kind: 'docker_socket' as const, service: 'web' }],
  target: { engine: 'native' as const, requiresAwakeComputerAndDockerDesktop: false, domains: 'notDetermined' as const },
};

describe('DeploymentReviewApprovalFacts', () => {
  it('R15-D3: a backup setup review is titled by what that press does, not by the Action\'s generic name', async () => {
    const { describeDeploymentBackupConfigureDecision } = await import('./DeploymentReviewApprovalFacts');
    const { t } = await import('@/text');
    const id = 'deployments.backups.configure';
    expect(describeDeploymentBackupConfigureDecision(id, { intent: 'test' })).toEqual({
      title: t('projects.deployments.review.decisionBackupTest'), approve: t('projects.deployments.review.approveBackupTest') });
    expect(describeDeploymentBackupConfigureDecision(id, { intent: 'initializeAndSave' })?.title)
      .toBe(t('projects.deployments.review.decisionBackupInitialize'));
    expect(describeDeploymentBackupConfigureDecision(id, { intent: 'save' })?.approve).toBe(t('projects.deployments.review.approveBackupSave'));
    expect(describeDeploymentBackupConfigureDecision('deployments.deploy', { intent: 'test' })).toBeNull();
  });
  it('reads a provider teardown as the decision it is: what it deletes, from where, and what goes with it (UI refinements 03:57Z)', async () => {
    const preview = { actionId: 'deployments.teardown', deploymentReview: { summary: 'Tear down deployment resources.', removal: {
      subject: { kind: 'platformResource', name: 'checkout-api', platform: 'Railway' }, environment: 'Production API',
      removeEnvironment: true, domains: ['shop.example.com'], volumes: [{ name: 'orders-data', removed: true }, { name: 'cache', removed: false }] } } };
    const approval = readDeploymentReviewApproval({ preview });
    if (!approval) throw new Error('Expected a typed removal review');
    expect(describeDeploymentReviewDecision(approval, 'deployments.teardown', null)).toEqual({
      title: 'projects.deployments.review.decisionDeletePlatform', description: 'projects.deployments.review.consequence',
      approve: 'projects.deployments.platformLink.confirmDelete',
    });
    const own = readDeploymentReviewApproval({ preview: { deploymentReview: { removal: { subject: { kind: 'ownServer' }, environment: 'Staging' } } } });
    expect(own && describeDeploymentReviewDecision(own, 'deployments.teardown', null)?.title).toBe('projects.deployments.deleteConfirmRemove');
    const screen = await renderScreen(<DeploymentReviewApprovalFacts approval={approval} serverId={null} testID="removal-facts"
      technicalRows={[{ kind: 'value', path: 'environmentId', title: 'Environment ID', value: 'env-7f3a', technical: true }]} />);
    const text = screen.getTextContent();
    expect(text).toContain('projects.deployments.review.removalWhatTitle');
    for (const value of ['Production API', 'Railway', 'checkout-api', 'Domain', 'shop.example.com', 'Stops responding',
      'orders-data', 'cache', 'projects.deployments.review.removalKeptTitle',
      'projects.deployments.review.removalEnvironmentToo']) expect(text).toContain(value);
    expect(text).not.toContain('env-7f3a');
    expect(text).not.toContain('manual');
    expect(text).not.toContain('projects.deployments.factStopsDomains');
  });

  it('names the exact provider project and environment in a mounted Delete review', async () => {
    const approval = readDeploymentReviewApproval({ preview: { deploymentReview: { removal: {
      subject: { kind: 'platformResource', name: 'Database template', platform: 'Cloud provider' },
      environment: 'Happier production',
      providerScope: { projectName: 'Storefront', environmentName: 'EU staging' },
    } } } });
    if (!approval) throw new Error('Expected the typed provider removal review');
    const screen = await renderScreen(<DeploymentReviewApprovalFacts approval={approval} serverId={null} testID="delete-review" />);
    expect(describeDeploymentReviewDecision(approval, 'deployments.teardown', null)?.title).toMatch(/^Deletes Storefront ·\sEU staging$/);
    expect(screen.getTextContent()).toMatch(/Storefront ·\sEU staging/);
    expect(screen.getTextContent()).not.toContain('Database template');
  });

  it.each([
    [{ kind: 'removed' }, 'projects.deployments.review.railwayVolumeWillRemove', false],
    [{ kind: 'kept', otherEnvironments: 2, url: 'https://railway.com/project/storefront/volume/orders' },
      'projects.deployments.review.railwayVolumeWillKeep 2', true],
    [{ kind: 'unchecked' }, 'projects.deployments.review.railwayVolumeUnchecked', false],
  ] as const)('renders the Railway database volume decision in the Delete review (%j)', async (volumeRemoval, fact, hasLink) => {
    const approval = readDeploymentReviewApproval({ preview: { deploymentReview: { removal: {
      subject: { kind: 'platformResource', name: 'orders-db', platform: 'Railway PostgreSQL' },
      environment: 'Production', volumeRemoval,
    } } } });
    if (!approval) throw new Error('Expected a typed Railway database removal review');
    const screen = await renderScreen(<DeploymentReviewApprovalFacts approval={approval} serverId={null} testID="delete-review" />);
    const text = screen.getTextContent();
    expect(text).toContain(fact);
    expect(text.includes('projects.deployments.review.railwayVolumeOpen')).toBe(hasLink);
  });

  it.each([
    ['Railway', 'teardown', 'observe', 'Remove the orders-api service'],
    ['Vercel', 'teardown', 'observe', 'Remove orders-api'],
    ['Cloudflare Pages', 'teardown', 'observe', 'Remove orders-api'],
    ['Cloudflare Workers', 'teardown', 'observe', 'Remove orders-api'],
    ['Railway', 'projects.delete', 'projects.observe', 'Remove orders-api'],
  ])('names the approved removal effects for %s (%s) while retaining the observation in the plan', async (platform, teardown, observe, title) => {
    const subject = { kind: 'platformResource', name: 'orders-api', platform };
    const action = { pluginId: 'fixture.deploy', localId: 'remove' };
    const preview = {
      deploymentReview: { removal: { subject, domains: ['orders.example.com'] } },
      hostReviewedChildren: { children: [
        { action, role: teardown },
        { action: { ...action, localId: 'observe' }, role: observe },
        { action, role: 'domains.remove', input: { domain: { hostname: 'orders.example.com' } } },
      ] },
    };
    const original = structuredClone(preview);
    const screen = await renderScreen(<ApprovalIncludedSteps preview={preview} serverId={null} testID="steps" />);
    expect(screen.findHostByTestId('steps.rows.row:step.0')).not.toBeNull();
    expect(screen.findHostByTestId('steps.rows.row:step.1')).not.toBeNull();
    expect(screen.findHostByTestId('steps.rows.row:step.2')).toBeNull();
    expect(screen.getTextContent()).toContain(title);
    expect(screen.getTextContent()).toContain('Remove its domain');
    expect(preview).toEqual(original);
    expect(readApprovalIncludedSteps(preview).map(step => step.role)).toEqual([teardown, observe, 'domains.remove']);
  });

  it.each([
    [{ kind: 'ownServer' }, 'disable', 'Remove its domain'],
    [{ kind: 'domain', hostname: 'orders.example.com' }, 'disable', 'Remove orders.example.com'],
    [{ kind: 'domain', hostname: 'orders.example.com' }, 'domains.remove', 'Remove orders.example.com'],
  ])('names the Domain removal for %j', async (subject, role, title) => {
    const preview = {
      deploymentReview: { removal: { subject, environment: 'Production', ...(subject.kind === 'ownServer'
        ? { domains: ['orders.example.com'] } : {}) } },
      hostReviewedChildren: { children: [{ action: { pluginId: 'fixture.deploy', localId: 'remove' }, role }] },
    };
    const approval = readDeploymentReviewApproval({ preview });
    if (!approval) throw new Error('Expected a typed removal review');
    const screen = await renderScreen(<>
      <DeploymentReviewApprovalFacts approval={approval} serverId={null} testID="facts" />
      <ApprovalIncludedSteps preview={preview} serverId={null} testID="steps" />
    </>);
    const text = screen.getTextContent();
    expect(text).toContain('Domain');
    expect(text).toContain('orders.example.com');
    expect(text).toContain('Stops responding');
    expect(text).toContain(title);
  });

  it('names the native placement and serving services with the retained volume decision', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const machine = createMachineFixture({ id: 'serving-machine-id', metadata: { displayName: 'Bakery server',
      host: 'bakery.local', platform: 'linux', happyCliVersion: '0.0.0-test', happyHomeDir: '/h', homeDir: '/h' } });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] },
      machineListStatusByServerId: { [serverId]: 'idle' } });
    const approval = readDeploymentReviewApproval({ preview: { deploymentReview: { removal: {
      subject: { kind: 'ownServer' }, environment: 'Production',
      placements: [{ machineId: machine.id, services: ['web', 'database'] }],
      volumes: [{ name: 'bakery_data', removed: false }],
    } } } });
    if (!approval) throw new Error('Expected a typed native removal review');
    const screen = await renderScreen(<DeploymentReviewApprovalFacts approval={approval} serverId={serverId} testID="native" />);
    const text = screen.getTextContent();
    expect(text).toContain('Bakery server');
    expect(text).toContain('web, database');
    expect(text).toContain('projects.deployments.review.removalKeptTitle');
    expect(text).toContain('bakery_data');
    expect(text).not.toContain(machine.id);
  });

  it('R19-D6: kept data reads under its own section, after what gets deleted, and a long volume name keeps one line', async () => {
    const raw = 'happier-dd861394d50d2003879d0ff0e91bea8c43397e5ecd64bb8c4562dd18f1a5ced2_postgres-data';
    const approval = readDeploymentReviewApproval({ preview: { deploymentReview: { removal: {
      subject: { kind: 'ownServer' }, environment: 'Production',
      volumes: [{ name: 'uploads', removed: true }, { name: raw, removed: false }],
    } } } });
    if (!approval) throw new Error('Expected a typed native removal review');
    const screen = await renderScreen(<DeploymentReviewApprovalFacts approval={approval} serverId={null} testID="teardown"
      technicalRows={[{ kind: 'value', path: 'environmentId', title: 'Environment ID', value: 'env-7f3a', technical: true }]} />);
    const textOf = (testID: string) => (screen.findByTestId(testID)?.findAll(node => typeof node.props?.children === 'string')
      .map(node => node.props.children as string) ?? []).join(' ');
    const deleted = textOf('teardown.fields');
    const kept = textOf('teardown.kept');
    expect(deleted).toContain('projects.deployments.review.removalWhatTitle');
    expect(deleted).toContain('uploads');
    expect(deleted).not.toContain(raw);
    expect(kept).toContain('projects.deployments.review.removalKeptTitle');
    expect(kept).toContain(raw);
    expect(kept).not.toContain('uploads');
    // The body never wraps a long name: one line, its exact value one press away under Technical details.
    expect(screen.findAll(node => node.props?.children === raw && node.props?.numberOfLines === 1).length).toBeGreaterThan(0);
    expect(deleted).not.toContain('approvals.technicalDetails');
    expect(kept).toContain('approvals.technicalDetails');
  });

  it('reads a host-reviewed provider create as the decision: what it creates, where, and from what (RAILWAY-VISUAL-ACCEPT D1)', async () => {
    const preview = { actionId: 'deployments.targets.link', hostReviewedContent: { summary: 'Create service checkout-api.',
      deploymentReview: { summary: 'Create service checkout-api.', platformCreate: { platformName: 'Railway', resourceName: 'checkout-api',
        environment: { id: 'env-production-api', name: 'Production API' },
        repository: 'acme/checkout', productionBranch: 'release', followsBranch: true } } } };
    const approval = readDeploymentReviewApproval({ preview });
    if (!approval) throw new Error('Expected a typed create review');
    expect(describeDeploymentReviewDecision(approval, 'deployments.targets.link', null)).toEqual({
      title: 'projects.deployments.review.decisionCreate', description: 'projects.deployments.review.consequence',
      approve: 'projects.deployments.review.approveCreate',
    });
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={approval} serverId={null} testID="create-facts" />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('projects.deployments.review.createWhatTitle');
    // The Happier Environment the new resource joins leads the facts, by name (RAILWAY-VISUAL-ACCEPT2 N1).
    expect(text).toContain('projects.deployments.review.environment');
    expect(text).toContain('Production API');
    expect(text).not.toContain('env-production-api');
    expect(text).toContain('Railway');
    expect(text).toContain('checkout-api');
    expect(text).toContain('acme/checkout');
    expect(text).toContain('projects.deployments.review.createFollowsBranch');
    // A create without a branch to follow (an uploaded Vercel project) still reads as its own decision.
    const upload = readDeploymentReviewApproval({ preview: { hostReviewedContent: { deploymentReview: {
      platformCreate: { platformName: 'Vercel', resourceName: 'upload-app' } } } } });
    expect(describeDeploymentReviewDecision(upload, 'deployments.targets.link', null)?.approve).toBe('projects.deployments.review.approveCreate');
  });

  it('shows the reviewed folder count, size and excluded paths before confirmation', async () => {
    const deploymentReview = { ...machineReview, revision: { kind: 'folder',
      manifestFingerprint: `sha256:${'a'.repeat(64)}`, fileCount: 4, totalBytes: 2_000_000,
      excludedPaths: ['.env.local', 'build.pipe', 'cache/item.txt'], unsupportedFilePaths: ['build.pipe'] } };
    const approval = readDeploymentReviewApproval({ preview: { deploymentReview } });
    if (!approval) throw new Error('Expected a typed folder review');
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={approval} serverId={null} testID="folder-facts" />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('4 files · 2 MB');
    expect(text).toContain('.env.local');
    expect(text).toContain('build.pipe (projects.deployments.review.folderUnsupportedFile)');
    expect(text).toContain('cache/item.txt');
  });
  it.each(['own-server', 'platform'] as const)('renders the version, replaced version, target and data effect for %s rollback', async target => {
    const facts = {
      environment: { id: 'env', name: 'Production' },
      revision: { kind: 'repository', sha: 'a'.repeat(40) },
      replaces: { deploymentId: 'serving', revision: { kind: 'repository', sha: 'b'.repeat(40) } },
    };
    const deploymentReview = target === 'own-server'
      ? { ...machineReview, ...facts, rollbackData: 'restoreBackup' }
      : { platformRollback: { ...facts, platformName: 'Vercel', providerResourceId: 'production-project', providerEnvironment: 'production',
          data: 'keep' }, providerReview: { sourceMethod: 'gitIntegration' } };
    const approval = readDeploymentReviewApproval({ preview: { deploymentReview } });
    if (!approval) throw new Error('Expected a typed Rollback review');
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={approval} serverId={null} testID="rollback-facts" />,
    );
    const displayed = screen.getTextContent();
    expect(displayed).toContain('aaaaaaa');
    expect(displayed).toContain('projects.deployments.review.replacesNote bbbbbbb');
    expect(displayed).toContain(target === 'own-server' ? 'projects.deployments.review.engineNative' : 'production-project');
    expect(displayed).toContain(target === 'own-server'
      ? 'projects.deployments.review.rollbackDataRestored' : 'projects.deployments.review.rollbackDataKept');
  });
  it.each(['own-server', 'platform'] as const)('names the selected %s Destination before the version', async target => {
    const environment = { id: 'destination', name: 'Production website' };
    const revision = { kind: 'repository', sha: 'a'.repeat(40) };
    const deploymentReview = target === 'own-server'
      ? { deployment: { ...machineReview, environment,
          revision: { kind: 'stored', contentRevision: 4, composeDigest: `sha256:${'d'.repeat(64)}` }, replaces: null },
        promotion: { artifact: 'image', previousDocument: 'previous', candidateDocument: 'candidate',
          sourceRevision: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'c'.repeat(64)}` } } }
      : { platformPromotion: { environment, revision, platformName: 'Vercel',
          providerResourceId: 'public-website', providerEnvironment: 'production' },
        providerReview: { sourceMethod: 'gitIntegration' } };
    const approval = readDeploymentReviewApproval({ preview: { deploymentReview } });
    if (!approval) throw new Error('Expected a typed Promotion review');
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={approval} serverId={null} testID="promotion-facts" />,
    );
    const text = screen.getTextContent().replace(/\s+/g, ' ').trim();
    expect(text.startsWith('projects.deployments.review.whatTitle projects.deployments.promotion.destination Production website ')).toBe(true);
    // One name for a deployed version on every surface (PAGE-ACCEPT-176 R12-D4): its short id, as the Receipt and Roll back say.
    expect(text).toContain(target === 'own-server' ? 'ccccccc' : 'aaaaaaa');
    expect(text).not.toContain('ddddddd');
    expect(text).not.toContain('Compose revision');
    // What the destination serves now belongs to the Destination, not to the version promoted (R12-D4).
    if (target === 'own-server') expect(text.indexOf('projects.deployments.review.replacesNothing'))
      .toBeLessThan(text.indexOf('projects.deployments.review.version'));
    expect(describeDeploymentReviewDecision(approval, 'deployments.promote', null)?.title)
      .toBe(target === 'own-server' ? 'Promote ccccccc to Production website' : 'Promote aaaaaaa to Production website');
    if (target === 'platform') expect(text).not.toContain('projects.deployments.review.promotionImages');
  });

  it.each([false, true])('shows required build platforms and the emulation cost without claiming an observed execution mode (controller: %s)', async controller => {
    const review = { ...machineReview,
      buildSupport: { status: 'notObserved' as const, requestedPlatforms: ['linux/amd64', 'linux/arm64'] } };
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: controller ? { ...machineReview,
        runtimeMachines: ['linux/amd64', 'linux/arm64'].map((platform, index) => ({ machineId: `runtime-${index}`,
          review: { ...review, buildSupport: { status: 'notObserved' as const, requestedPlatforms: [platform] } } })) } : review,
        promotion: null }}
        serverId={getActiveServerSnapshot().serverId} testID="build-facts" />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('linux/amd64, linux/arm64');
    expect(text).toContain('projects.deployments.review.buildPlatforms');
    expect(text).toContain('projects.deployments.review.emulationCost');
  });
  it.each([false, true])('shows changed reference names and phases from the host review (controller: %s)', async controller => {
    const review = { ...machineReview, risks: [], referenceChanges: [
      { name: 'DATABASE_URL', phase: 'runtime' as const },
      { name: 'BUILD_ENDPOINT', phase: 'build' as const },
    ] };
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: controller
        ? { ...machineReview, risks: [], runtimeMachines: [{ machineId: 'machine-target', review }] } : review,
        promotion: null }} serverId={getActiveServerSnapshot().serverId} testID="facts" />,
    );
    expect(screen.findHostByTestId('facts.risks')).not.toBeNull();
    const text = screen.getTextContent();
    for (const fact of ['DATABASE_URL', 'BUILD_ENDPOINT', 'projects.deployments.phaseRuntime',
      'projects.deployments.phaseBuild', 'projects.deployments.editors.referenceAddressChanged']) expect(text).toContain(fact);
    const unchanged = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, risks: [] }, promotion: null }}
        serverId={getActiveServerSnapshot().serverId} testID="unchanged" />,
    );
    expect(unchanged.findHostByTestId('unchanged.risks')).toBeNull();
  });

  it('says which Happier network path a changed reference took, and nothing for a native-network one', async () => {
    const review = { ...machineReview, risks: [], referenceChanges: [
      { name: 'DATABASE_URL', phase: 'runtime' as const, route: { kind: 'iroh' as const, observedPath: 'relay' as const } },
      { name: 'CACHE_URL', phase: 'runtime' as const, route: { kind: 'iroh' as const, observedPath: 'direct' as const } },
      { name: 'QUEUE_URL', phase: 'runtime' as const, route: { kind: 'iroh' as const, observedPath: 'unknown' as const } },
      { name: 'SEARCH_URL', phase: 'runtime' as const },
    ] };
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review, promotion: null }}
        serverId={getActiveServerSnapshot().serverId} testID="routes" />,
    );
    const text = screen.getTextContent();
    for (const route of ['referenceRouteRelay', 'referenceRouteDirect', 'referenceRouteUnknown']) {
      expect(text.split(`projects.deployments.editors.${route}`)).toHaveLength(2);
    }
    // The changed-address treatment still applies to every changed reference, routed or not.
    expect(text.split('projects.deployments.editors.referenceAddressChanged')).toHaveLength(5);
  });

  it('says a redeploy of the running version as that, not "replaces" itself (PAGE-ACCEPT-100 D10)', async () => {
    const revision = { kind: 'stored' as const, contentRevision: 2, composeDigest: `sha256:${'a'.repeat(64)}` };
    const other = { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` };
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, risks: [], revision, replaces: { revision } } as never, promotion: null }}
        serverId={getActiveServerSnapshot().serverId} testID="same" />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('projects.deployments.review.replacesSame');
    expect(text).not.toContain('projects.deployments.review.replacesNote');
    const older = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, risks: [], revision, replaces: { revision: other } } as never, promotion: null }}
        serverId={getActiveServerSnapshot().serverId} testID="older" />,
    );
    expect(older.getTextContent()).toContain('projects.deployments.review.replacesNote');
  });

  it('stops asking to check once the request is decided, and keeps what it flagged (PAGE-ACCEPT-100 D10)', async () => {
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: machineReview, promotion: null }} decided
        serverId={getActiveServerSnapshot().serverId} testID="decided" />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('projects.deployments.review.risksNotedTitle');
    expect(text).not.toContain('projects.deployments.review.risksTitle');
    expect(text).toContain('projects.deployments.review.risk.privileged');
  });

  it('shows the selected deployment failure policy independently of migration recovery', async () => {
    const fleet = [{ machineId: 'machine-a', review: machineReview }, { machineId: 'machine-b', review: machineReview }];
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, onFailure: 'keepPartial', runtimeMachines: fleet,
        ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true } }, promotion: null } as never}
        serverId={getActiveServerSnapshot().serverId} testID="facts" />,
    );
    expect(screen.getTextContent()).toContain('projects.deployments.receipt.keepPartial');
  });

  // PAGE-ACCEPT-176 R12-D4: "If a Machine fails" is a fleet choice; a one-Machine Environment has no other Machine.
  it('omits the fleet failure policy for a one-Machine deploy', async () => {
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, onFailure: 'rollbackAll',
        ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true } }, promotion: null }}
        serverId={getActiveServerSnapshot().serverId} testID="facts" />,
    );
    expect(screen.getTextContent()).not.toContain('projects.deployments.receipt.policy');
  });

  it('shows the collector and when its private route resolves for a multi-Machine deploy', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const collector = createMachineFixture({ id: 'collector-id', metadata: { displayName: 'Staging collector', host: 'collector.local',
      platform: 'linux', happyCliVersion: '0.0.0-test', happyHomeDir: '/h', homeDir: '/h' } });
    storage.setState({ machines: { [collector.id]: collector },
      machineListByServerId: { [serverId]: [collector] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const deploymentReview = { ...machineReview, runtimeMachines: [
      { machineId: collector.id, review: machineReview },
      { machineId: 'app-machine', review: { ...machineReview, deferredTelemetryCollectorMachineId: collector.id } },
    ] };
    const approval = readDeploymentReviewApproval({ preview: { deploymentReview } });
    if (!approval) throw new Error('Expected a typed deploy review');
    const screen = await renderScreen(<DeploymentReviewApprovalFacts approval={approval} serverId={serverId} testID="facts" />);
    const contents = screen.getTextContent();
    expect(contents).toContain('projects.deployments.review.telemetryCollector');
    expect(contents).toContain('Staging collector');
    expect(contents).toContain('projects.deployments.review.telemetryCollectorAtLaunch');
    expect(contents).not.toContain('collector-id');
  });

  it.each([['x64', false], ['arm64', true], [null, true]] as const)(
    'says the emulation cost only when the build is not for the Machine\'s own CPU (arch %s)', async (arch, emulated) => {
      const serverId = getActiveServerSnapshot().serverId;
      const machine = createMachineFixture({ id: 'machine-target', metadata: { displayName: 'Build box', host: 'b.local',
        platform: 'linux', happyCliVersion: '0.0.0-test', happyHomeDir: '/h', homeDir: '/h', ...(arch ? { arch } : {}) } });
      storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] },
        machineListStatusByServerId: { [serverId]: 'idle' } });
      const screen = await renderScreen(
        <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, machineId: 'machine-target',
          buildSupport: { status: 'notObserved' as const, requestedPlatforms: ['linux/amd64'] } }, promotion: null }}
          serverId={serverId} testID="facts" />,
      );
      expect(screen.getTextContent()).toContain('linux/amd64');
      expect(screen.getTextContent().includes('projects.deployments.review.emulationCost')).toBe(emulated);
    });

  it('promises no restored release on a first deploy, where nothing served before (R20-D8)', async () => {
    const ownServer = { rollout: 'recreate', autoRestorePreviousRelease: true };
    const render = (replaces: unknown) => renderScreen(<DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, risks: [],
      revision: { kind: 'repository', sha: 'a'.repeat(40) }, replaces, ownServer } as never, promotion: null }}
      serverId={null} testID="facts" />);
    expect((await render(null)).getTextContent()).not.toContain('projects.deployments.review.ifItFails');
    standardCleanup();
    expect((await render({ deploymentId: 'serving', revision: { kind: 'repository', sha: 'b'.repeat(40) } })).getTextContent())
      .toContain('projects.deployments.review.restoresVersion');
  });

  it('does not redraw the approval page when only the Machine presence changes', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const machine = createMachineFixture({ id: 'machine-target', metadata: { displayName: 'Rebound workstation', host: 'w.local',
      platform: 'darwin', happyCliVersion: '0.0.0-test', happyHomeDir: '/h', homeDir: '/h' } });
    const publish = (next: typeof machine) => storage.setState({ machines: { [next.id]: next },
      machineListByServerId: { [serverId]: [next] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    publish(machine);
    const commits = vi.fn();
    const screen = await renderScreen(
      <React.Profiler id="facts" onRender={commits}>
        <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview, machineId: 'machine-target' }, promotion: null }}
          serverId={serverId} testID="facts" />
      </React.Profiler>,
    );
    expect(screen.getTextContent()).toContain('Rebound workstation');
    commits.mockClear();
    for (const active of [false, true, false]) {
      await act(async () => publish({ ...machine, active, activeAt: active ? 5 : 1 }));
    }
    expect(commits).not.toHaveBeenCalled();
    // A rename is a real change of what the page says.
    await act(async () => publish({ ...machine, metadata: { ...machine.metadata!, displayName: 'Renamed workstation' } }));
    expect(screen.getTextContent()).toContain('Renamed workstation');
  });

  it('puts the root-granting settings in one callout above the rest, not in the neutral rows', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const screen = await renderScreen(
      <DeploymentReviewApprovalFacts approval={{ review: { ...machineReview }, promotion: null }} serverId={serverId} testID="facts" />,
    );
    expect(screen.findByTestId('facts.risks')).not.toBeNull();
    const text = screen.getTextContent();
    expect(text).toContain('projects.deployments.review.risk.privileged');
    expect(text).toContain('projects.deployments.review.risk.docker_socket');
  });
});


it.each([false, true])('presents name-only Compose use warnings from the host review (controller: %s)', async controller => {
  const review = { ...machineReview, risks: [], variableUseWarnings: [
    { kind: 'unusedBinding' as const, name: 'LOG_LEVEL' }, { kind: 'unboundVariable' as const, name: 'REDIS_URL' },
  ] };
  const screen = await renderScreen(<DeploymentReviewApprovalFacts approval={{ review: controller
    ? { ...machineReview, risks: [], runtimeMachines: [{ machineId: 'target', review }] } : review,
    promotion: null }} serverId={getActiveServerSnapshot().serverId} testID="facts" />);
  expect(screen.findHostByTestId('facts.risks')).not.toBeNull();
  expect(screen.getTextContent()).toContain('LOG_LEVEL');
  expect(screen.getTextContent()).toContain('REDIS_URL');
});

describe('an Environment update approval (a data Move cutover) reads as what it changes', () => {
  // The Move's cutover request as the Workflow sends it: exact ids, revisions, Compose text and a secret reference.
  const document = 'services:\n  web:\n    image: app:1\n    environment:\n      DATABASE_URL: postgres://happier:${DB_MOVE_PASSWORD}@${DB_MOVE_HOST}:${DB_MOVE_PORT}/app\n';
  const secretRef = 'happier:shared-secret:v1:9b2558ae-476f-436c-b63b-e4fca6098553';
  const actionArgs = { serverId: 'server-1', environmentId: 'env-app', expectedRevision: 4, contentArtifactId: '786dc6c9-0f58-831a-be04-e2fe84052d00',
    contentHeaderVersion: 1, contentBodyVersion: 1,
    patch: { definition: { from: 'compose', document, profiles: [], services: ['web'], primaryService: 'web' },
      bindings: { set: [
        { purpose: 'variable', phase: 'runtime', name: 'DB_MOVE_HOST', source: { kind: 'reference', environmentId: 'env-reporting', export: 'postgres', via: 'auto', component: 'host' } },
        { purpose: 'variable', phase: 'runtime', name: 'DB_MOVE_PORT', source: { kind: 'reference', environmentId: 'env-reporting', export: 'postgres', via: 'auto', component: 'port' } },
        { purpose: 'variable', phase: 'runtime', name: 'DB_MOVE_PASSWORD', source: { kind: 'secret', ref: secretRef, resourceRevision: 1 } },
      ], remove: [] } } };

  it('names the Environment, what stops and what each variable reads, with no ids, Compose text or secret reference', () => {
    const approval = readDeploymentEnvironmentUpdateApproval({ actionId: 'deployments.environments.update', actionArgs });
    expect(approval).not.toBeNull();
    const { rows } = describeDeploymentEnvironmentUpdateFields(approval!, { name: 'Harbor QA', services: ['web', 'postgres'] },
      { 'env-reporting': 'Reporting' });
    const facts = rows.map(row => row.kind === 'value' ? `${row.title}=${row.value}` : row.kind);
    expect(facts).toEqual([
      'projects.deployments.review.environment=Harbor QA',
      'projects.deployments.review.updateRemovesServices=postgres',
      'DB_MOVE_HOST=projects.deployments.sourceReference',
      'DB_MOVE_PORT=projects.deployments.sourceReference',
      'DB_MOVE_PASSWORD=projects.deployments.sourceSavedSecret',
      'projects.deployments.review.updateDefinition=projects.deployments.review.updateDefinitionChanged',
    ]);
    const shown = JSON.stringify(rows);
    for (const raw of ['env-app', 'env-reporting', '786dc6c9', secretRef, 'DATABASE_URL']) expect(shown).not.toContain(raw);
    expect(describeDeploymentEnvironmentUpdateDecision(approval, 'Harbor QA')).toBe('projects.deployments.review.decisionUpdateEnvironment');
  });

  it('keeps the generic reading for a preview or a settings-only update', () => {
    expect(readDeploymentEnvironmentUpdateApproval({ actionId: 'deployments.environments.update',
      actionArgs: { ...actionArgs, mode: 'preview' } })).toBeNull();
    expect(readDeploymentEnvironmentUpdateApproval({ actionId: 'deployments.environments.update',
      actionArgs: { ...actionArgs, patch: { protection: 'production' } } })).toBeNull();
    expect(readDeploymentEnvironmentUpdateApproval({ actionId: 'deployments.deploy', actionArgs })).toBeNull();
  });

  // The previews switch's Save as the Settings page sends it (R20-D2): ids, a boolean and the forge's identity.
  const previewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
    repository: { kind: 'github', deployment: 'https://github.com', repository: 'hapier-qa/field-guide-site' },
    runtimeTargetLinkId: 'link-runtime', domain: null, bindingBlueprints: [], data: [] };
  const previewsArgs = { serverId: 'server-1', environmentId: 'env-fg', expectedRevision: 3,
    contentArtifactId: '786dc6c9-0f58-831a-be04-e2fe84052d00', contentHeaderVersion: 1, contentBodyVersion: 1,
    patch: { previewTemplate } };

  it('says a previews switch turns previews on for the Environment, where each copy runs, with no ids or booleans', () => {
    const approval = readDeploymentEnvironmentUpdateApproval({ actionId: 'deployments.environments.update', actionArgs: previewsArgs });
    expect(approval).not.toBeNull();
    const { rows } = describeDeploymentEnvironmentUpdateFields(approval!,
      { name: 'field-guide-site Production', services: null, previewsOn: false, previewMachine: 'NLDW3-5-36-33' }, {});
    const facts = rows.map(row => row.kind === 'value' ? `${row.title}=${row.value}` : row.kind);
    expect(facts).toEqual(['projects.deployments.review.updatePreviews=projects.deployments.review.updatePreviewsOn']);
    const shown = JSON.stringify(rows);
    for (const raw of ['env-fg', 'link-runtime', '786dc6c9', 'true', 'github']) expect(shown).not.toContain(raw);
    // Turning previews off says so; a change while they stay on says it changes how they are made.
    const off = readDeploymentEnvironmentUpdateApproval({ actionId: 'deployments.environments.update',
      actionArgs: { ...previewsArgs, patch: { previewTemplate: { ...previewTemplate, enabled: false } } } });
    expect(describeDeploymentEnvironmentUpdateFields(off!, { name: 'Staging', services: null, previewsOn: true, previewMachine: null }, {})
      .rows.map(row => row.kind === 'value' ? row.value : row.kind)).toEqual(['projects.deployments.review.updatePreviewsOff']);
    expect(describeDeploymentEnvironmentUpdateFields(approval!, { name: 'Staging', services: null, previewsOn: true, previewMachine: null }, {})
      .rows.map(row => row.kind === 'value' ? row.value : row.kind)).toEqual(['projects.deployments.review.updatePreviewsChanged']);
  });

  it('reads a preview create as the preview of its template for one pull request', () => {
    const approval = readDeploymentPreviewCreateApproval({ actionId: 'deployments.environments.create', actionArgs: {
      serverId: 'server-1', projectSourceId: 'source-1', requestKey: 'a'.repeat(64), mode: 'apply', name: 'pr-3', purpose: 'preview',
      protection: 'nonProduction', deployerMode: 'managers',
      preview: { templateEnvironmentId: 'env-fg', expectedTemplateRevision: 3, runtimeTargetLinkId: 'link-runtime',
        pullRequestId: '5536414932', headSha: 'b'.repeat(40), provenance: { v: 1, templateEnvironmentId: 'env-fg',
          runtimeTargetLinkId: 'link-runtime', repository: previewTemplate.repository, headRepository: previewTemplate.repository,
          pullRequestId: '5536414932', pullRequestNumber: 3, author: { id: '1', login: 'octo' } } } } });
    expect(approval).toEqual({ templateEnvironmentId: 'env-fg', runtimeTargetLinkId: 'link-runtime', pullRequestNumber: 3 });
    const { rows } = describeDeploymentPreviewCreateFields(approval!, { name: 'field-guide-site Production', machine: 'NLDW3-5-36-33' });
    expect(rows.map(row => row.kind === 'value' ? `${row.title}=${row.value}` : row.kind)).toEqual([
      'projects.deployments.review.previewCreate=projects.deployments.review.previewCreateValue',
      'projects.deployments.review.previewCreateMachine=NLDW3-5-36-33',
    ]);
    expect(describeDeploymentPreviewCreateDecision(approval, 'field-guide-site Production'))
      .toBe('projects.deployments.review.decisionPreviewCreate');
    // A standard Create keeps its own reading.
    expect(readDeploymentPreviewCreateApproval({ actionId: 'deployments.environments.create',
      actionArgs: { serverId: 'server-1', purpose: 'standard' } })).toBeNull();
  });
});
