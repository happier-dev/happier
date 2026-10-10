// @vitest-environment jsdom
// FUI6 scratch capture (removed after capture): real Machines owners through react-native-web, screenshotted in Chromium.
// screenshots them in Chromium so they can be put next to the lane12-final lab frames.
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { View, Text as RNText } from 'react-native';
import { it, vi } from 'vitest';

const dark = process.env.MV_THEME === 'dark';
const width = Number(process.env.MV_WIDTH ?? 720);
const out = process.env.MV_OUT ?? '/tmp/mv-capture';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.unmock('@/components/ui/icons/Icon');
vi.unmock('@/text');
vi.mock('react-native-svg', async () => {
  const React = await import('react');
  const flat = (style: unknown): Record<string, unknown> => Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean).map(flat)) : ((style as Record<string, unknown>) ?? {});
  const host = (tag: string) => {
    const C = React.forwardRef((props: Record<string, unknown>, ref) => {
      const { style, children, testID, accessibilityElementsHidden, importantForAccessibility, color, ...rest } = props;
      void testID; void accessibilityElementsHidden; void importantForAccessibility;
      const extra = tag === 'svg' ? { xmlns: 'http://www.w3.org/2000/svg', style: { display: 'block', ...flat(style) } } : {};
      const fixed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (typeof v === 'function') continue;
        fixed[k] = v === 'currentColor' && typeof color === 'string' ? color : v;
      }
      return React.createElement(tag, { ref, ...fixed, ...(typeof color === 'string' && tag === 'svg' ? { color } : {}), ...extra }, children as never);
    });
    return C;
  };
  const Svg = host('svg');
  return { default: Svg, Svg, Path: host('path'), G: host('g'), Circle: host('circle'), Ellipse: host('ellipse'), Rect: host('rect'),
    Line: host('line'), Polyline: host('polyline'), Polygon: host('polygon'), Defs: host('defs'), ClipPath: host('clipPath'),
    LinearGradient: host('linearGradient'), RadialGradient: host('radialGradient'), Stop: host('stop'), Mask: host('mask'), Text: host('text'), TSpan: host('tspan'), Use: host('use'),
    SvgXml: host('g'), Symbol: host('symbol') };
});
vi.mock('react-native-unistyles', async () => {
  const { lightTheme, darkTheme } = await import('@/theme');
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock({
    theme: (process.env.MV_THEME === 'dark' ? darkTheme : lightTheme) as never,
  });
});
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

const fontsDir = join(
  process.env.VITEST_UI_SOURCES_DIR ?? process.cwd(),
  'assets/fonts',
);
function fontFaces(): string {
  const faces: Array<[string, string]> = [
    ['Inter-Regular', 'Inter-Regular.ttf'],
    ['Inter-Medium', 'Inter-Medium.ttf'],
    ['Inter-SemiBold', 'Inter-SemiBold.ttf'],
    ['Inter-Italic', 'Inter-Italic.ttf'],
    ['IBMPlexMono-Regular', 'IBMPlexMono-Regular.ttf'],
    ['IBMPlexSans-Regular', 'IBMPlexSans-Regular.ttf'],
    ['IBMPlexSans-SemiBold', 'IBMPlexSans-SemiBold.ttf'],
    ['Inter', 'Inter-Regular.ttf'],
  ];
  return faces
    .map(
      ([family, file]) =>
        `@font-face{font-family:"${family}";src:url(data:font/ttf;base64,${readFileSync(join(fontsDir, file)).toString('base64')}) format("truetype");}`,
    )
    .join('\n');
}

function serialize(container: HTMLElement, bg: string): string {
  const styles = Array.from(document.querySelectorAll('style'))
    .map((element) => {
      const rules = (element as HTMLStyleElement).sheet?.cssRules;
      return rules
        ? Array.from(rules)
            .map((rule) => rule.cssText)
            .join('\n')
        : (element.textContent ?? '');
    })
    .join('\n');
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces()}</style><style>${styles}</style>` +
    `<style>html,body{margin:0;background:${bg};font-family:Inter-Regular,Inter,Arial,sans-serif;-webkit-font-smoothing:antialiased}</style>` +
    `</head><body><div id="root" style="display:flex;flex-direction:column;width:${width}px;padding:16px;box-sizing:border-box">${container.innerHTML}</div></body></html>`
  );
}

function Label(props: { children: string; color: string }) {
  return (
    <RNText
      style={{
        fontSize: 10,
        color: props.color,
        marginTop: 14,
        marginBottom: 6,
        fontFamily: 'IBMPlexMono-Regular',
      }}
    >
      {props.children}
    </RNText>
  );
}

// Chunked so interleaved worker output cannot corrupt one long line: `MVC <name> <index>/<count> <base64>`.
function emitPng(name: string, png: Buffer): void {
  const b64 = png.toString('base64');
  const size = 2000;
  const count = Math.ceil(b64.length / size);
  for (let index = 0; index < count; index += 1) {
    process.stdout.write(`\nMVC ${name} ${index}/${count} ${b64.slice(index * size, (index + 1) * size)}\n`);
  }
}

// Scratch: Defaults chooses its disclosure on wide layouts; jsdom reports a phone otherwise.
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useDeviceType: () => (width >= 700 ? 'tablet' : 'phone'),
}));

// Scratch: a composer popover's content is what is judged; the anchored popover shell needs a live composer.
vi.mock('@/components/sessions/agentInput/components/AgentInputContentPopover', () => ({
  AgentInputContentPopover: (props: { open: boolean; content: () => React.ReactNode }) => <>{props.content()}</>,
}));

it('captures FUI6 surfaces', async () => {
  const { installWebLayoutBridge, measureWebLayout, resolveChromiumExecutable } = await import('@/dev/testkit/render/measureWebLayout');
  installWebLayoutBridge();
  const { lightTheme, darkTheme } = await import('@/theme');
  const theme = dark ? darkTheme : lightTheme;
  (window as unknown as { innerWidth: number }).innerWidth = width;
  const compact = width < 600;
  const { ManagedMachineConfigurator } = await import('@/components/settings/machines/managed/ManagedMachineConfigurator');
  const { ManagedSizeTable, ManagedImageTiles, ManagedLocationGroup } = await import('@/components/settings/machines/managed/ManagedChoiceSections');
  const { MachineProvisionerSections } = await import('@/components/settings/machines/managed/MachineProvisionerSections');
  const { MachinePresetDetail } = await import('@/components/settings/machines/managed/MachinePresetDetail');
  const { MachineConfigurationReceipt } = await import('@/components/settings/machines/managed/MachineConfigurationReceipt');
  const { ManagedReceiptPageLayout } = await import('@/components/settings/machines/managed/ManagedReceiptPageLayout');
  const { ManagedMachinePolicySection, ManagedMachineControllerSection, ManagedMachineRecipeSection, ManagedMachineWorkSection, ManagedScopeRuleRow } =
    await import('@/components/settings/machines/managed/ManagedMachineDetailSections');
  const { ManagedMachineStateRow, ManagedCreationDisabledBanner } = await import('@/components/settings/machines/managed/ManagedMachineStateRow');
  const { ManagedDecisionRow } = await import('@/components/settings/machines/managed/ManagedMachineSections');
  const { buildManagedConfigurationReceipt, describeManagedConfigurationSummary } = await import('@/components/settings/machines/managed/managedConfigurationPresentation');
  const { describeRetention, describeRetentionConsequence } = await import('@/components/settings/machines/managed/managedRetentionPresentation');
  const { MachineEnvironmentSection } = await import('@/components/settings/machines/managed/MachineEnvironmentSection');
  const { ManagedProgressPopoverContent, buildRequesterDisclosureStatusBadge } = await import('@/components/machines/managed/managedComposerBadges');
  const { AttentionBanner, attentionBannerPoint } = await import('@/components/ui/lists/AttentionBanner');
  const { SegmentedTabBar } = await import('@/components/ui/navigation/SegmentedTabBar');
  const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
  const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
  const { ItemList } = await import('@/components/ui/lists/ItemList');
  const { PageHeader } = await import('@/components/ui/layout/PageHeader');
  const { Icon } = await import('@/components/ui/icons/Icon');
  const { t } = await import('@/text');
  const { resolvePluginContributedActionIconName } = await import('@/components/plugins/actions/pluginContributedActionPresentation');
  const c = theme.colors;
  const noop = () => {};
  const mark = (icon: string) => <Icon name={resolvePluginContributedActionIconName(icon)} size={28} />;
  const rowMark = (icon: string) => <Icon name={resolvePluginContributedActionIconName(icon)} />;
  // The leaves' contributed brand marks, drawn by the real host brand owner from the packaged bytes.
  const { InstalledPluginBrandMark } = await import('@/components/plugins/shared/InstalledPluginBrandMark');
  const { managedPresetLimitRow } = await import('@/components/settings/machines/managed/MachinePresetDetail');
  const brandBytes = (leaf: string) => new Uint8Array(readFileSync(join(process.cwd(), '../../packages/plugins', `machine-${leaf}`, 'assets/brand.png')));
  const brand = (leaf: string, name: string, monochrome = false) => <InstalledPluginBrandMark
    brand={{ displayName: name, bytes: brandBytes(leaf), ...(monochrome ? { monochrome: true } : {}) }} externallyLabelled pixelSize={28} />;
  const panels: Array<[string, React.ReactNode]> = [];
  const guard = (id: string, build: () => React.ReactNode) => {
    try { panels.push([id, build()]); } catch (error) { console.info('MV FAIL build', id, String(error).slice(0, 400)); }
  };
  const GB = 1024 ** 3;

  // m-add A / Ap: one segmented bar, then four local and five cloud provisioners.
  const ready = { tone: 'ready' as const, label: t('managedMachines.add.status.ready') };
  const choose = { kind: 'choose' as const, label: t('managedMachines.add.action.choose'), onPress: noop };
  const repair = (label: string) => ({ kind: 'repair' as const, label, onPress: noop });
  guard('add', () => <ItemList><PageHeader title={t('settingsOverview.addMachineTitle')} description={t('managedMachines.add.pageDescription')} />
    <ItemGroup surface="none"><View style={{ alignSelf: 'flex-start', maxWidth: '100%' }}>
      <SegmentedTabBar role="radiogroup" segmentSizing="content" testIDPrefix="path" activeTabId="create" onSelectTab={noop} tabs={[
        { id: 'thisComputer', label: t('addFlows.pathThisComputerTitle') }, { id: 'ssh', label: t('addFlows.pathSshChip') },
        { id: 'anotherComputer', label: t('addFlows.pathAnotherTitle') }, { id: 'create', label: t('managedMachines.add.createPath') }]} />
    </View></ItemGroup>
    <MachineProvisionerSections compact={compact} testID="prov" localTitle={t('managedMachines.add.onThisComputer')}
      localDescription={t('managedMachines.add.localDescription', { computer: 'MacBook Pro', cores: '12', memory: '36 GB', disk: '412 GB' })}
      cards={[
        { id: 'lima', title: 'Lima', kind: 'VM', description: 'A light Linux VM for code, scripts and dev servers.', location: 'local', mark: mark('terminal'), status: ready, action: choose },
        { id: 'lume', title: 'Lume', kind: 'VM', description: 'macOS or Linux VMs, for Xcode and Apple-only tests.', location: 'local', mark: mark('desktop'), status: ready, action: choose },
        { id: 'cua', title: 'Cua sandbox', kind: 'Sandbox', description: 'A sandboxed Linux desktop whose windows you can watch.', location: 'local', mark: brand('cua', 'Cua', true),
          status: { tone: 'attention', label: t('managedMachines.add.status.needsSetup') }, action: repair(t('managedMachines.add.action.setUp')) },
        { id: 'docker', title: 'Docker sandbox', kind: 'Sandbox', description: 'A container sandbox for scripts and services.', location: 'local', mark: brand('docker-sandboxes', 'Docker'), status: ready, action: choose },
        { id: 'hetzner', title: 'Hetzner', kind: 'Server', description: 'Servers billed to your Hetzner project.', location: 'cloud', mark: brand('hetzner', 'Hetzner'),
          status: { tone: 'ready', label: 'Hetzner · Work' }, action: choose },
        { id: 'do', title: 'DigitalOcean', kind: 'Droplet', description: 'Droplets billed to your DigitalOcean team.', location: 'cloud', mark: brand('digitalocean', 'DigitalOcean'),
          status: { tone: 'none', label: t('managedMachines.add.status.noAccount') }, action: repair(t('managedMachines.add.action.connect')) },
        { id: 'fly', title: 'Fly', kind: 'Machine', description: 'Machines with a persistent volume, billed only while running.', location: 'cloud', mark: brand('fly', 'Fly', true),
          status: { tone: 'ready', label: 'Fly · Acme' }, action: choose },
        { id: 'modal', title: 'Modal Sandbox', kind: 'Sandbox', description: 'Short-lived sandboxes for scripts. Modal ends each one at its time limit.', location: 'cloud', mark: brand('modal', 'Modal', true),
          status: { tone: 'none', label: t('managedMachines.add.status.noAccount') }, action: repair(t('managedMachines.add.action.connect')) },
        { id: 'crabbox', title: 'Crabbox', kind: 'Server', description: 'Servers through Crabbox. Create and delete only.', location: 'cloud', mark: mark('hard-drives'),
          status: { tone: 'attention', label: t('managedMachines.add.status.needsSetup') }, action: repair(t('managedMachines.add.action.setUp')) },
      ]} />
  </ItemList>);

  // m-life: banners with two ways forward, and the Machine page's offline checks.
  const hz = brand('hetzner', 'Hetzner');
  const commands = ['happier daemon status', 'happier self update'];
  const points = t('machine.offlineHelp').split('\n').map((line) => line.replace(/^\s*•\s*/, '').trim()).filter(Boolean).map((line) => attentionBannerPoint(line, commands));
  guard('banners', () => <ItemList>
    <ManagedMachineStateRow testID="b1" name="hz-build-0" mark={hz} provider="Hetzner" state={{ kind: 'cleanupPending', reason: 'Hetzner returned 503.' }}
      handlers={{ openProvider: noop, tryAgain: noop }} />
    <ManagedMachineStateRow testID="b2" name="hz-build-3" mark={hz} provider="Hetzner"
      state={{ kind: 'controllerWaiting', name: 'hz-build-3', controller: 'MacBook Pro', provider: 'Hetzner' }} handlers={{ cancel: noop }} />
    <ManagedCreationDisabledBanner testID="b3" />
    <AttentionBanner testID="off" title={t('machineDetailPage.unavailableTitle')} points={points} action={{ label: t('common.retry'), onPress: noop }} />
  </ItemList>);

  // m-presets A / Ap: the model MachinePresetView builds, through the real receipt builder.
  const environment = { toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"' }, setupScript: 'corepack enable\npnpm install\npnpm build',
    secretRefs: { v: 1 as const, bindings: { NPM_TOKEN: { ref: 'secret-npm' } } } };
  const caps = { supportedIntents: ['start' as const, 'stop' as const, 'delete' as const] };
  const doLaunch = { provider: { pluginId: 'happier.machine-digitalocean', localId: 'droplet' }, schemaVersion: 1, name: 'Acme build box', choices: {} };
  const doFacts = { launch: doLaunch, controller: { machineId: 'b1', installationId: 'i' }, optionStatus: 'current' as const, prerequisites: [],
    billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const }, retentionCapabilities: caps,
    retention: { kind: 'unused' as const, afterMs: 7_200_000, effect: 'delete' as const }, wakeOnAcceptedMessage: false,
    nativeFacts: { size: { id: 's-8vcpu-16gb', title: 's-8vcpu-16gb', cpuCores: 8, memoryBytes: 16 * GB, diskBytes: 320 * GB },
      image: { id: 'u24', title: 'Ubuntu 24.04' }, location: { id: 'ams3', title: 'Amsterdam', countryCode: 'NL' } },
    prices: [{ amount: '0.143', currency: 'USD', unit: 'hour', source: 'DigitalOcean', observedAt: Date.now() - 20 * 60_000 }] };
  const doMark = brand('digitalocean', 'DigitalOcean');
  const presetModel = (input: { personal: boolean }) => {
    const local = input.personal;
    const lumeLaunch = { provider: { pluginId: 'happier.machine-lume', localId: 'vm' }, schemaVersion: 1, name: 'Mac desktop', choices: {} };
    const lumeFacts = { launch: lumeLaunch, controller: { machineId: 'mbp', installationId: 'i' }, optionStatus: 'current' as const, prerequisites: [],
      billing: { location: 'local' as const, stoppedBilling: 'none' as const }, retentionCapabilities: caps,
      retention: { kind: 'unused' as const, afterMs: 3_600_000, effect: 'stop' as const }, wakeOnAcceptedMessage: true,
      nativeFacts: { size: { id: 'm', title: 'Medium', cpuCores: 4, memoryBytes: 8 * GB, diskBytes: 80 * GB }, image: { id: 'tahoe', title: 'macOS Tahoe' } },
      localResources: { availableCpuCores: 12, availableMemoryBytes: 36 * GB } };
    const facts = local ? lumeFacts : doFacts;
    const provider = local ? 'Lume' : 'DigitalOcean';
    const kind = local ? 'VM' : 'Droplet';
    const m = local ? mark('desktop') : doMark;
    const receipt = buildManagedConfigurationReceipt({ launch: facts.launch, reviewedFacts: facts, providerTitle: provider, controllerName: local ? 'MacBook Pro' : 'build-01',
      homeName: 'Acme', environment: local ? undefined : environment, preset: { id: 'p', revision: 4, name: facts.launch.name },
      presetPolicy: { retention: facts.retention }, caption: t('managedMachines.receipt.eachOne', { revision: 4 }), mark: m } as never);
    const what = t('managedMachines.detail.kindFact', { provider, kind });
    return { name: facts.launch.name, mark: m,
      description: local ? t('machinePresets.purposePersonal', { what }) : t('machinePresets.purposeTeam', { what, team: 'Acme' }),
      meta: [{ key: 'home', text: 'Acme' }, { key: 'owner', text: local ? t('machinePresets.ownerPersonal') : 'Acme' }],
      audience: { title: local ? t('machinePresets.onlyYou') : 'Acme',
        description: local ? t('machinePresets.audiencePersonalHelp') : t('machinePresets.audienceTeamHelp', { team: 'Acme', provider }),
        leading: <Icon name={local ? 'user' : 'users'} color={c.text.secondary} />,
        subtitle: [t('machinePresets.canUse'), t('machinePresets.canManage')].join(' · ') },
      // As MachinePresetView builds them for a manager: both rows edit in place through machines.presets.update.
      limit: { description: t('machinePresets.limitHelp'), row: managedPresetLimitRow({ limit: local ? undefined : 3, onChange: noop }) },
      controller: { description: t('managedMachines.controller.required', { controller: local ? 'MacBook Pro' : 'build-01' }), row: {
        title: t('machinePresets.controllerRow'), subtitle: t('status.online'), value: 'b1', onChange: noop,
        choices: [{ id: 'b1', title: local ? 'MacBook Pro' : 'build-01', subtitle: t('status.online') }, { id: 'devbox', title: 'devbox', subtitle: t('status.offline') }] } },
      machines: local ? [] : [
        { id: 'a', title: 'do-build-7', subtitle: `${t('machinePresets.fromRevision', { name: 'Acme build box', revision: 4 })} · Running 3 h`, mark: doMark, onPress: noop },
        { id: 'b', title: 'do-build-8', subtitle: `${t('machinePresets.fromRevision', { name: 'Acme build box', revision: 4 })} · Running 20 min`, mark: null, onPress: noop }],
      receipt: { ...receipt, secondary: [{ label: t('machinePresets.editChoices'), testID: 'edit', onPress: noop }], secondaryNote: t('machinePresets.futureOnly') },
      onCreateOne: noop, onArchive: noop };
  };
  guard('preset-team', () => <MachinePresetDetail model={presetModel({ personal: false }) as never} compact={compact} testID="preset" />);
  guard('preset-local', () => <MachinePresetDetail model={presetModel({ personal: true }) as never} compact={compact} testID="presetl" />);

  // m-config A / Ap / Ap2 and L / Lp: the configurator around the real receipt, with the billing footnote.
  const config = (local: boolean) => {
    const hzLaunch = { provider: { pluginId: 'happier.machine-hetzner', localId: 'server' }, schemaVersion: 1, name: local ? 'mac-vm-2' : 'hz-build-2', choices: {} };
    const facts = local
      ? { launch: hzLaunch, controller: { machineId: 'mbp', installationId: 'i' }, optionStatus: 'current' as const, prerequisites: [],
        billing: { location: 'local' as const, stoppedBilling: 'none' as const }, retentionCapabilities: caps, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
        nativeFacts: { size: { id: 'm', title: 'Medium', cpuCores: 4, memoryBytes: 8 * GB, diskBytes: 80 * GB }, image: { id: 'tahoe', title: 'macOS Tahoe' } },
        localResources: { availableCpuCores: 12, availableMemoryBytes: 36 * GB } }
      : { launch: hzLaunch, controller: { machineId: 'mbp', installationId: 'i' }, optionStatus: 'current' as const, prerequisites: [],
        billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const }, retentionCapabilities: caps, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
        nativeFacts: { size: { id: 'cx32', title: 'CX32', cpuCores: 4, memoryBytes: 8 * GB, diskBytes: 80 * GB }, image: { id: 'u24', title: 'Ubuntu 24.04' },
          location: { id: 'fsn1', title: 'Falkenstein', countryCode: 'DE' } },
        prices: [{ amount: '0.0119', currency: 'EUR', unit: 'hour', source: 'Hetzner', observedAt: Date.now() - 20 * 60_000 },
          { amount: '7.49', currency: 'EUR', unit: 'month', source: 'Hetzner', observedAt: Date.now() - 20 * 60_000 }] };
    const provider = local ? 'Lume' : 'Hetzner';
    const policy = { retention: facts.retention, wakeOnAcceptedMessage: false };
    const receipt = { ...buildManagedConfigurationReceipt({ launch: facts.launch, reviewedFacts: facts, providerTitle: provider, controllerName: 'MacBook Pro', homeName: 'Personal Home', keepEditedBelow: true,
      mark: local ? mark('desktop') : hz } as never), onRename: noop,
      keep: { policy, inherited: true, defaultPolicy: policy, categoryLabel: local ? 'Local' : 'Cloud billed while stopped', effects: ['stop', 'delete'] as const, canWake: true, deadline: true,
        consequence: (retention: Parameters<typeof describeRetentionConsequence>[0]) => describeRetentionConsequence(retention,
          { location: local ? 'local' : 'cloud', stoppedBilling: local ? 'none' : 'billed', provider } as never), onChange: noop, onReset: noop },
      primary: { label: t('managedMachines.receipt.createKind', { kind: local ? 'VM' : 'Server' }), onPress: noop,
        footnote: local ? t('managedMachines.receipt.localFootnote', { provider, computer: 'MacBook Pro' }) : t('managedMachines.receipt.cloudFootnote', { provider, account: 'Work' }) },
      secondary: [{ label: t('managedMachines.receipt.saveAsPreset'), onPress: noop, tone: 'text' as const }] };
    return { facts, provider, receipt };
  };
  const sizes = [
    { id: 'cx22', name: 'CX22', cpu: '2', memory: '4 GB', disk: '40 GB', spec: 'CX22', hourly: '€0.0060', monthly: '€3.79' },
    { id: 'cx32', name: 'CX32', cpu: '4', memory: '8 GB', disk: '80 GB', spec: 'CX32', hourly: '€0.0119', monthly: '€7.49' },
    { id: 'cx42', name: 'CX42', cpu: '8', memory: '16 GB', disk: '160 GB', spec: 'CX42', hourly: '€0.0292', monthly: '€18.42' },
  ];
  const locations = [{ id: 'fsn1', city: 'Falkenstein', country: 'Germany', countryCode: 'DE' }, { id: 'nbg1', city: 'Nuremberg', country: 'Germany', countryCode: 'DE' },
    { id: 'hel1', city: 'Helsinki', country: 'Finland', countryCode: 'FI' }, { id: 'ash', city: 'Ashburn, VA', country: 'United States', countryCode: 'US' }];
  guard('config-cloud', () => { const { facts, receipt } = config(false);
    return <View style={{ height: compact ? 1500 : 1250 }}>
      <ManagedMachineConfigurator title={t('managedMachines.config.newKind', { provider: 'Hetzner', kind: 'Server' })} description={compact ? undefined : t('managedMachines.config.description')}
        mark={hz} compact={compact} testID="cfg" receipt={receipt as never}
        summary={{ value: '€0.0119', unit: t('managedMachines.price.perHour'), spec: describeManagedConfigurationSummary(facts as never) ?? '' }}>
        <ItemGroup title={t('managedMachines.config.size')}><ManagedSizeTable sizes={sizes} value="cx32" onChange={noop} compact={compact} testID="sizes" /></ItemGroup>
        <ItemGroup title={t('managedMachines.config.image')} description={t('managedMachines.config.imageDescription')}>
          <ManagedImageTiles images={[{ id: 'u24', name: 'Ubuntu 24.04', description: 'Long-term support' }, { id: 'd12', name: 'Debian 12', description: 'Small and stable' }]} value="u24" onChange={noop} testID="images" />
        </ItemGroup>
        <ManagedLocationGroup title={t('managedMachines.config.location')} description={t('managedMachines.config.locationDescription')} value="fsn1" onChange={noop} testID="loc" locations={locations} />
      </ManagedMachineConfigurator></View>; });
  guard('config-local', () => { const { facts, receipt } = config(true);
    return <View style={{ height: compact ? 1100 : 1000 }}>
      <ManagedMachineConfigurator title={t('managedMachines.config.newKind', { provider: 'Lume', kind: 'VM' })} description={compact ? undefined : t('managedMachines.config.description')}
        mark={mark('desktop')} compact={compact} testID="cfgl" receipt={receipt as never}
        summary={{ value: t('managedMachines.price.noBill'), unit: '', spec: describeManagedConfigurationSummary(facts as never) ?? '' }}>
        <ItemGroup title={t('managedMachines.config.image')} description={t('managedMachines.config.imageDescription')}>
          <ManagedImageTiles images={[{ id: 'tahoe', name: 'macOS Tahoe', description: 'For Xcode and Apple-only tests' }, { id: 'u24', name: 'Ubuntu 24.04', description: 'Linux desktop' }]} value="tahoe" onChange={noop} testID="imagesl" />
        </ItemGroup>
        <ItemGroup title={t('managedMachines.config.size')} description={t('managedMachines.config.localSizeDescription', { computer: 'MacBook Pro' })}>
          <ManagedSizeTable sizes={[{ id: 's', name: 'Small', cpu: '2', memory: '4 GB', disk: '40 GB', spec: 'Small', headroom: '10 cores · 32 GB' },
            { id: 'm', name: 'Medium', cpu: '4', memory: '8 GB', disk: '80 GB', spec: 'Medium', headroom: '8 cores · 28 GB' }]} value="m" onChange={noop} compact={compact} testID="sizesl" /></ItemGroup>
      </ManagedMachineConfigurator></View>; });
  // m-config Ap2: the receipt as the phone sheet shows it.
  guard('receipt-sheet', () => <View style={{ width: Math.min(width - 32, 360) }}><ItemList>
    <MachineConfigurationReceipt model={config(false).receipt as never} testID="rc" /></ItemList></View>);
  guard('receipt-sheet-local', () => <View style={{ width: Math.min(width - 32, 360) }}><ItemList>
    <MachineConfigurationReceipt model={config(true).receipt as never} testID="rcl" /></ItemList></View>);

  // m-detail A / Ap and B / B2 / Bp: a created machine beside its receipt; a session-created one carries its archive rule.
  const detail = (sessionCreated: 'no' | 'rule' | 'waiting') => {
    const launch = { provider: { pluginId: 'happier.machine-hetzner', localId: 'server' }, schemaVersion: 1, name: 'hz-build-2', choices: {} };
    const facts = { ...config(false).facts, launch, preset: { id: 'build', revision: 3, name: 'Build box' } };
    const receipt = { ...buildManagedConfigurationReceipt({ launch, reviewedFacts: facts, providerTitle: 'Hetzner', mark: hz, homeName: 'Acme',
      preset: { id: 'build', revision: 3 }, created: true, controllerName: 'MacBook Pro' } as never),
      secondary: [{ label: t('managedMachines.actions.stop'), testID: 'stop', tone: 'bordered' as const, onPress: noop },
        { label: t('managedMachines.actions.delete'), testID: 'delete', tone: 'text' as const, onPress: noop }] };
    const policy = { retention: { kind: 'unused' as const, afterMs: 3_600_000, effect: 'stop' as const }, wakeOnAcceptedMessage: true };
    return <ManagedReceiptPageLayout testID={`detail-${sessionCreated}`} compact={compact} receipt={receipt as never}
      header={{ title: 'hz-build-2', alwaysShowTitle: true, description: t('managedMachines.detail.madeFromPreset', { preset: 'Build box' }), leading: hz,
        meta: [{ key: 'p', text: t('managedMachines.detail.runningFor', { duration: '3 h' }) },
          { key: 'k', text: t('managedMachines.detail.kindFactWithId', { fact: t('managedMachines.detail.kindFact', { provider: 'Hetzner', kind: 'Server' }), id: '58213904' }) }, { key: 'os', text: 'Linux' }] }}>
      <ManagedMachineWorkSection testID="work" rows={[{ id: 's1', title: 'Fix settings modal remount', subtitle: 'Claude Code · working', leading: <Icon name="chat-circle" /> }]} />
      {sessionCreated === 'no' ? null : <ItemGroup title={t('managedRetention.scopeSessionTitle')}>
        <ManagedScopeRuleRow testID="rule" rule={{ scope: 'session', summary: sessionCreated === 'waiting' ? 'Delete' : 'Stop', waiting: sessionCreated === 'waiting', onOpen: noop } as never} />
      </ItemGroup>}
      <ManagedMachinePolicySection testID="policy" description={t('managedRetention.changedFor', { name: 'hz-build-2' })}
        keep={{ policy, inherited: false, defaultPolicy: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
          effects: ['stop', 'delete'], canWake: true, deadline: true,
          consequence: (retention: Parameters<typeof describeRetentionConsequence>[0]) => describeRetentionConsequence(retention, { location: 'cloud', stoppedBilling: 'billed', provider: 'Hetzner' }),
          onChange: noop, onReset: noop } as never}
        compactSummary={compact ? { summary: describeRetention(policy.retention), onPress: noop } : undefined} />
      <ManagedMachineControllerSection testID="ctl" description={t('managedMachines.controller.required', { controller: 'MacBook Pro' })}
        controller={{ name: 'MacBook Pro', icon: <Icon name="desktop" />, online: true, presence: 'Online · this computer', move: { kind: 'movable', onPress: noop } }} />
      <ManagedMachineRecipeSection testID="recipe" rows={[
        { id: 'size', title: 'CX32', subtitle: '4 cores · 8 GB · 80 GB disk', leading: <Icon name="cpu" /> },
        { id: 'image', title: 'Ubuntu 24.04', subtitle: 'Long-term support', leading: <Icon name="image" /> }]} />
    </ManagedReceiptPageLayout>;
  };
  guard('detail-enrolled', () => detail('no'));
  guard('detail-session', () => detail('rule'));
  guard('detail-session-waiting', () => detail('waiting'));

  // m-pick Aprogd / Aprogp and S / Sp: the composer's popovers.
  const card = { borderRadius: 16, borderWidth: 1, borderColor: c.border?.default ?? '#ddd', backgroundColor: c.surface?.elevated ?? c.surface?.base, overflow: 'hidden' as const };
  const popover = { width: Math.min(width - 32, 380), ...card };
  const stages = [{ id: 'create', label: 'Create VM', status: 'done' as const }, { id: 'install', label: 'Install Happier', status: 'active' as const },
    { id: 'join', label: 'Join Personal Home', status: 'pending' as const }];
  guard('progress-creating', () => <View style={popover}><ManagedProgressPopoverContent model={{ machineName: 'mac-vm-2', mark: rowMark('desktop'),
    recipe: 'Mac desktop · macOS Tahoe · on MacBook Pro', stages, failed: false, label: 'Installing Happier on mac-vm-2', elapsed: '1:12',
    message: 'Your message waits and starts on mac-vm-2 as soon as it joins. macOS takes a few minutes the first time.',
    archiveChoice: { value: 'keep', onChange: noop }, onCancel: noop }} /></View>);
  guard('progress-failed', () => <View style={popover}><ManagedProgressPopoverContent model={{ machineName: 'build-01', mark: hz,
    recipe: 'Build box · Hetzner CX32 · on MacBook Pro', stages: [...stages.map((s) => ({ ...s, status: 'done' as const })), { id: 'setup', label: 'Set up', status: 'failed' as const }],
    failed: true, label: 'Set up · Failed', failureTitle: 'Setup failed on build-01', message: 'pnpm install exited with code 1. Your message waits here.',
    onRetrySetup: noop, onContinueWithoutSetup: noop, onDeleteMachine: noop }} /></View>);
  guard('progress-install-failed', () => <View style={popover}><ManagedProgressPopoverContent model={{ machineName: 'build-01', mark: null,
    recipe: 'Build box · Hetzner CX32 · on MacBook Pro', stages: [{ id: 'create', label: 'Create server', status: 'done' as const }, { id: 'install', label: 'Install Happier', status: 'failed' as const }],
    failed: true, label: 'Install · Failed', message: 'The installer could not reach build-01.', onRetryInstall: noop, onDeleteMachine: noop }} /></View>);
  guard('requester', () => { const badge = buildRequesterDisclosureStatusBadge({ owner: 'Ben', machine: 'build-01', signIn: 'scoped', signInPurposes: ['Claude Code'], onLearnMore: noop });
    return <View style={{ gap: 12 }}><RoundButton size="small" display="inverted" title={badge.label} onPress={noop} />
      <View style={{ width: Math.min(width - 32, 360), ...card }}>{badge.renderPopover?.({ open: true, anchorRef: { current: null }, onRequestClose: noop } as never)}</View></View>; });

  // D53 Environment, decision rows.
  guard('env', () => <ItemList><MachineEnvironmentSection testID="env" environment={environment as never} editable scope={null} onChange={noop} /></ItemList>);
  guard('decision-rows', () => <ItemList>
    <ManagedDecisionRow testID="del" footnote={t('managedMachines.dependencies.help')} onCancel={noop}
      confirm={{ label: t('managedMachines.actions.deleteMachine'), testID: 'x', disabled: false, loading: false, onPress: noop }} />
    <ManagedDecisionRow testID="can" footnote={t('managedMachines.detail.cancelDescription')}
      confirm={{ label: t('managedMachines.actions.cancelCreation'), testID: 'z', disabled: false, loading: false, onPress: noop }} />
  </ItemList>);

  mkdirSync(out, { recursive: true });
  const { chromium } = await import('playwright');
  const exe = resolveChromiumExecutable();
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  const bg = c.surface?.base ?? (dark ? '#111' : '#fff');
  const only = process.env.MV_ONLY ? new Set(process.env.MV_ONLY.split(',')) : null;
  for (const [id, node] of panels) {
    if (only && !only.has(id)) continue;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const name = `${id}-${dark ? 'dark' : 'light'}-${width}`;
    try {
      await act(async () => root.render(<View style={{ width: width - 32 }}><Label color={c.text.tertiary}>{`${id} · ${dark ? 'dark' : 'light'} · ${width}`}</Label>{node}</View>));
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
      // Feed the browser's boxes back into onLayout so width-dependent owners (banners, columns, tables) take their real shape.
      try {
        await measureWebLayout(host, { viewport: { width: width - 32, height: 900 }, settle: async (replay) => { await act(async () => { await replay(); }); } });
      } catch (error) { console.info('MV WARN settle', id, String(error).slice(0, 200)); }
      await page.setContent(serialize(host, bg));
      await page.evaluate(() => document.fonts.ready);
      await page.locator('#root').screenshot({ path: join(out, `${name}.png`) });
      emitPng(name, readFileSync(join(out, `${name}.png`)));
      console.info('MV shot', id);
    } catch (error) {
      console.info('MV FAIL', id, String(error).slice(0, 400));
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }
  await browser.close();
}, 900_000);
