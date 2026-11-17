import { Text } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { HappierSetupSteps, type HappierSetupStep } from './SetupSteps.js';

const STEPS: readonly HappierSetupStep[] = [
  {
    key: 'create',
    title: 'Create VM',
    state: 'done',
    meta: '42 s',
    testID: 'step:create',
  },
  {
    key: 'install',
    title: 'Install Happier',
    state: 'running',
    testID: 'step:install',
  },
  {
    key: 'sign-in',
    title: 'Sign in',
    state: 'waiting',
    testID: 'step:sign-in',
  },
  {
    key: 'join',
    title: 'Join Personal Home',
    state: 'upcoming',
    testID: 'step:join',
  },
];

// The adapter owns its icon host; the shared owner decides which glyph and tone each state takes.
const renderStateGlyph = (
  glyph: Readonly<{ state: string; tone: string; size: number }>,
) => <Text testID={`glyph:${glyph.state}:${glyph.tone}`}>{glyph.state}</Text>;

const query = (
  view: ReturnType<typeof mountThroughReactNativeWeb>,
  testID: string,
) => view.container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

describe('setup steps as ordered progress', () => {
  it('paints each progress state on the numbered rail: settled glyphs, a working spinner, the count still ahead', () => {
    const theme = createSurfaceContext().theme;
    const view = mountThroughReactNativeWeb(
      <HappierSetupSteps
        testID="steps"
        theme={theme}
        renderStateGlyph={renderStateGlyph}
        steps={[
          ...STEPS,
          {
            key: 'verify',
            title: 'Verify',
            state: 'failed',
            testID: 'step:verify',
          },
          {
            key: 'cleanup',
            title: 'Clean up',
            state: 'cancelled',
            testID: 'step:cleanup',
          },
        ]}
      />,
    );
    expect(query(view, 'steps')?.getAttribute('role')).toBe('list');
    expect(
      query(view, 'step:create:marker')?.querySelector(
        '[data-testid="glyph:done:success"]',
      ),
    ).not.toBeNull();
    // The working step says it is busy and spins in its marker instead of showing its count.
    expect(query(view, 'step:install')?.getAttribute('aria-busy')).toBe('true');
    expect(query(view, 'step:install:marker')?.textContent).toBe('');
    expect(
      query(view, 'step:sign-in:marker')?.querySelector(
        '[data-testid="glyph:waiting:attention"]',
      ),
    ).not.toBeNull();
    expect(query(view, 'step:join:marker')?.textContent).toBe('4');
    expect(
      query(view, 'step:verify:marker')?.querySelector(
        '[data-testid="glyph:failed:danger"]',
      ),
    ).not.toBeNull();
    // A cancelled step is settled without a glyph from the adapter: no count, no tone.
    expect(query(view, 'step:cleanup:marker')?.textContent).toBe('');
    expect(
      query(view, 'step:cleanup:marker')?.querySelector(
        '[data-testid^="glyph:"]',
      ),
    ).toBeNull();
    // A settled fact sits at the row's end.
    expect(query(view, 'step:create')?.textContent).toContain('42 s');
  });

  it('paints the compact list as one quiet line per step with ink marks; only a failure takes colour', () => {
    const theme = createSurfaceContext().theme;
    const view = mountThroughReactNativeWeb(
      <HappierSetupSteps
        testID="steps"
        variant="compact"
        theme={theme}
        renderStateGlyph={renderStateGlyph}
        steps={[
          ...STEPS,
          {
            key: 'verify',
            title: 'Verify',
            state: 'failed',
            detail: 'Not shown in a line',
            testID: 'step:verify',
          },
        ]}
      />,
    );
    expect(query(view, 'steps')?.getAttribute('role')).toBe('list');
    expect(
      query(view, 'step:create')?.querySelector(
        '[data-testid="glyph:done:muted"]',
      ),
    ).not.toBeNull();
    expect(query(view, 'step:create')?.textContent).toBe('doneCreate VM42 s');
    expect(query(view, 'step:install')?.getAttribute('aria-busy')).toBe('true');
    expect(
      query(view, 'step:sign-in')?.querySelector(
        '[data-testid="glyph:waiting:neutral"]',
      ),
    ).not.toBeNull();
    expect(query(view, 'step:join')?.textContent).toBe('Join Personal Home');
    expect(
      query(view, 'step:verify')?.querySelector(
        '[data-testid="glyph:failed:danger"]',
      ),
    ).not.toBeNull();
    expect(query(view, 'step:verify')?.textContent).not.toContain(
      'Not shown in a line',
    );
  });

  it('places a step\'s one operation at the end of the step, beside its words, apart from the content beneath', () => {
    const theme = createSurfaceContext().theme;
    const view = mountThroughReactNativeWeb(
      <HappierSetupSteps
        theme={theme}
        steps={[
          {
            key: 'invite',
            title: 'Invite people',
            detail: 'Everyone you invite joins the Home.',
            state: 'current',
            action: <Text testID="invite-action">Invite people</Text>,
            body: <Text testID="invite-body">Pending: 2</Text>,
            testID: 'step:invite',
          },
        ]}
      />,
    );
    const step = query(view, 'step:invite')!;
    const action = query(view, 'invite-action')!;
    const body = query(view, 'invite-body')!;
    // The operation stands in its own slot of the step: its wrapper holds it alone, while the
    // step's words and the content beneath stay together in the step.
    expect(step.contains(action)).toBe(true);
    expect(action.parentElement?.textContent).toBe('Invite people');
    expect(action.parentElement?.contains(body)).toBe(false);
    expect(step.textContent).toContain('Everyone you invite joins the Home.');
  });

  it('hands the adapter the colour and weight each title takes, so it binds only its text host', () => {
    const theme = createSurfaceContext().theme;
    const seen: Record<string, string> = {};
    mountThroughReactNativeWeb(
      <HappierSetupSteps
        theme={theme}
        variant="compact"
        renderStateGlyph={renderStateGlyph}
        renderTitle={(step, title) => {
          seen[step.key] = `${title.variant}:${title.weight}:${title.color}`;
          return <Text>{step.title}</Text>;
        }}
        steps={[...STEPS, { key: 'verify', title: 'Verify', state: 'failed' }]}
      />,
    );
    expect(seen).toEqual({
      create: `compact:regular:${theme.colors.secondaryText}`,
      install: `compact:medium:${theme.colors.text}`,
      'sign-in': `compact:medium:${theme.colors.text}`,
      join: `compact:regular:${theme.colors.mutedText}`,
      verify: `compact:regular:${theme.colors.danger}`,
    });
  });
});
