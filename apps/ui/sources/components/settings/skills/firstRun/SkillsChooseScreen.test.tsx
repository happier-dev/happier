import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSeededSkillsHome } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { StyleSheet } from 'react-native';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { capabilityDismissalState } from '@/sync/domains/state/persistentUiState';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      pathname: '/settings/skills/choose',
      router: navigation,
    }).module,
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
installDisconnectedServerSocketBoundary();
const { SkillsChooseScreen } = await import('./SkillsChooseScreen');
const { resetPromptLibraryCatalogEngineForTests } =
  await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } =
  await import('@/sync/store/settings/promptLibraryCatalogSnapshot');

afterEach(() => {
  standardCleanup();
  resetPromptLibraryCatalogEngineForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
  vi.clearAllMocks();
});

// Three skills that no rule has decided yet; two were used in sessions, most recent first.
const usage = {
  key: 'skill-usage' as const,
  value: { v: 1 as const, lastUsedAt: { 'release-notes': 200, pdf: 100 } },
};

const SEEDED = ['pdf', 'meeting-notes', 'release-notes'];

async function chooseHome(origin: string) {
  const home = await createSeededSkillsHome(origin, {
    skills: [{ id: 'pdf' }, { id: 'meeting-notes' }, { id: 'release-notes' }],
    records: [usage],
  });
  capabilityDismissalState.remove('skillsFirstRunDecidedAt');
  return home;
}

function rowOrder(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
  return ['release-notes', 'pdf', 'meeting-notes']
    .map((id) => ({ id, at: screen.getTextContent().indexOf(id) }))
    .sort((a, b) => a.at - b.at)
    .map((row) => row.id);
}

it('ranks used skills first and pre-ticks them, then Turn on writes Everywhere for exactly the ticked ones and lands home', async () => {
  const home = await chooseHome('https://skills-choose-turn-on.test');
  const receipt = createDeferred<void>();
  const requested = createDeferred<void>();
  const handle = home.catalog.handle.bind(home.catalog);
  // Hold only the Home's rule-mutation acknowledgement; the real Action and rule writer stay mounted.
  const boundary = vi.spyOn(home.catalog, 'handle').mockImplementation(async (path, init) => {
    if (path.endsWith('/skill-rules') && init?.method === 'POST') {
      requested.resolve();
      await receipt.promise;
    }
    return handle(path, init);
  });
  try {
    const screen = await renderScreen(<SkillsChooseScreen />);
    await vi.waitFor(
      () => expect(screen.findByTestId('skills.choose.turnOn')).not.toBeNull(),
      { timeout: 10_000 },
    );
    expect(rowOrder(screen)).toEqual(['release-notes', 'pdf', 'meeting-notes']);
    expect(screen.getTextContent()).toContain('2 selected');
    // Untick one, tick the unused one: the write follows the person's ticks, not the defaults.
    await act(async () => screen.pressByTestId('skills.choose.pdf'));
    await act(async () => screen.pressByTestId('skills.choose.meeting-notes'));
    await act(async () => screen.pressByTestId('skills.choose.turnOn'));
    await requested.promise;
    expect(capabilityDismissalState.read('skillsFirstRunDecidedAt')).toBeUndefined();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.findByTestId('skills.choose.turnOn')?.props.disabled).toBe(true);
    await act(async () => { receipt.resolve(); });
    await vi.waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith('/settings/skills'),
    );
    const rules = home.catalog.read('skill-rules').value as {
      rules: readonly {
        skillId: string;
        enabled: boolean;
        target: { t: string };
      }[];
    };
    expect(
      rules.rules
        // The Account's first-party seed rule is not the person's choice; only library skills count.
        .filter((rule) => SEEDED.includes(rule.skillId) && rule.enabled && rule.target.t === 'allMachines')
        .map((rule) => rule.skillId)
        .sort(),
    ).toEqual(['meeting-notes', 'release-notes']);
    expect(rules.rules.some((rule) => rule.skillId === 'pdf')).toBe(false);
    expect(
      capabilityDismissalState.read('skillsFirstRunDecidedAt'),
    ).toEqual(expect.any(Number));
  } finally {
    receipt.resolve();
    boundary.mockRestore();
    await standardCleanup();
    await home.dispose();
  }
});

it('keeps an empty selection and a refused rule write eligible, then retries the same selected skills', async () => {
  const home = await chooseHome('https://skills-choose-retry.test');
  const handle = home.catalog.handle.bind(home.catalog);
  let refuse = true;
  // A failed HTTP mutation must not become a device-local first-run decision.
  const boundary = vi.spyOn(home.catalog, 'handle').mockImplementation(async (path, init) => {
    if (refuse && path.endsWith('/skill-rules') && init?.method === 'POST')
      return Response.json({ error: 'unavailable' }, { status: 503 });
    return handle(path, init);
  });
  try {
    const screen = await renderScreen(<SkillsChooseScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('skills.choose.turnOn')).not.toBeNull(), { timeout: 10_000 });
    await act(async () => screen.pressByTestId('skills.choose.selectAll'));
    expect(screen.getTextContent()).toContain('3 selected');
    await act(async () => screen.pressByTestId('skills.choose.selectAll'));
    expect(screen.getTextContent()).toContain('0 selected');
    expect(screen.findByTestId('skills.choose.turnOn')?.props.disabled).toBe(true);
    expect(home.catalog.requests.filter(request => request.key === 'skill-rules')).toEqual([]);
    expect(capabilityDismissalState.read('skillsFirstRunDecidedAt')).toBeUndefined();
    expect(screen.findByTestId('skills.choose.nothingWaits')).toBeNull();
    await act(async () => screen.pressByTestId('skills.choose.meeting-notes'));
    await act(async () => screen.pressByTestId('skills.choose.turnOn'));
    await vi.waitFor(() => expect(screen.findByTestId('skills.choose.error')).not.toBeNull());
    expect(capabilityDismissalState.read('skillsFirstRunDecidedAt')).toBeUndefined();
    expect(screen.findByTestId('skills.choose.nothingWaits')).toBeNull();
    expect(screen.getTextContent()).toContain('1 selected');
    expect(navigation.push).not.toHaveBeenCalled();
    refuse = false;
    await act(async () => screen.pressByTestId('skills.choose.turnOn'));
    await vi.waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/settings/skills'));
    const rules = home.catalog.read('skill-rules');
    if (rules.key !== 'skill-rules') throw new Error('Expected skill rules');
    expect(rules.value.rules.filter(rule => SEEDED.includes(rule.skillId)).map(rule => rule.skillId)).toEqual(['meeting-notes']);
    expect(capabilityDismissalState.read('skillsFirstRunDecidedAt')).toEqual(expect.any(Number));
  } finally {
    boundary.mockRestore();
    await standardCleanup();
    await home.dispose();
  }
});

it('Not now ends the moment on this device without writing a rule, and the page then says nothing waits', async () => {
  const home = await chooseHome('https://skills-choose-not-now.test');
  try {
    const screen = await renderScreen(<SkillsChooseScreen />);
    await vi.waitFor(
      () => expect(screen.findByTestId('skills.choose.notNow')).not.toBeNull(),
      { timeout: 10_000 },
    );
    await act(async () => screen.pressByTestId('skills.choose.notNow'));
    expect(navigation.push).toHaveBeenCalledWith('/settings/skills');
    expect(
      (home.catalog.read('skill-rules').value as { rules: readonly { skillId: string }[] })
        .rules.filter((rule) => SEEDED.includes(rule.skillId)),
    ).toEqual([]);
    await vi.waitFor(() =>
      expect(screen.findByTestId('skills.choose.nothingWaits')).not.toBeNull(),
    );
    expect(screen.findByTestId('skills.choose.bar')).toBeNull();
  } finally {
    await standardCleanup();
    await home.dispose();
  }
});

it('keeps Not now and Turn on above the phone tab bar that floats over the page', async () => {
  const home = await chooseHome('https://skills-choose-tab-bar.test');
  try {
    const barBottomPadding = async (chromeHeight: number) => {
      const screen = await renderScreen(
        <SessionCockpitBottomChromeHeightContext.Provider value={chromeHeight}>
          <SkillsChooseScreen />
        </SessionCockpitBottomChromeHeightContext.Provider>,
      );
      await vi.waitFor(() => expect(screen.findByTestId('skills.choose.turnOn')).not.toBeNull(), { timeout: 10_000 });
      return Number(StyleSheet.flatten(screen.findByTestId('skills.choose.bar')!.props.style)?.paddingBottom);
    };
    // The bar reserves exactly the floating bar's measured height on top of what it carries without one.
    expect((await barBottomPadding(84)) - (await barBottomPadding(0))).toBe(84);
  } finally {
    await standardCleanup();
    await home.dispose();
  }
});
