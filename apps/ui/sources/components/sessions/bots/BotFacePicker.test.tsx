import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BotFaceBodySchema,
  BotFacePaletteSchema,
  BotFaceStyleSchema,
  type BotFaceStyle,
  type SessionBotFaceV1,
} from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { normaliseAndValidateBotFaceShape } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({ storage: 'real' });
vi.mock('@shopify/react-native-skia', async () =>
  (
    await import('@/dev/testkit/mocks/reactNativeSkia')
  ).createReactNativeSkiaMock(),
);
vi.mock(
  '@/components/sessions/bots/face/BotFaceRasterView',
  async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'),
);

// The Action front door is the UI's boundary to the Action runtime (admission, transport, tuple write); this suite
// owns what the picker asks of it, the composed Action suite owns what the runtime does with it.
const execute = vi.fn(
  async (_actionId: string, _input: unknown, _context: unknown) => ({
    ok: true as const,
    result: {},
  }),
);
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
  createFrontDoorActionExecute: () => execute,
  createFrontDoorUiActionExecutor: () => execute,
}));

const { BotFacePickerPanel } = await import('./BotFacePicker');
const { useSessionBotFaceEditor } = await import('./SessionBotFaceMark');
const { botFaceSeedNumber } = await import('./face/botFaceIdentity');
const { SessionBotFace } = await import('./face/SessionBotFace');
const { storage } = await import('@/sync/domains/state/storageStore');
const initialSettings = storage.getState().settings;
const setAccountStyle = (botFaceStyle: BotFaceStyle) => act(() => {
  storage.setState({ settings: { ...storage.getState().settings, botFaceStyle } });
});
afterEach(async () => {
  await standardCleanup();
  storage.setState({ settings: initialSettings });
});

const tileIds = (root: ReactTestInstance, prefix: string) =>
  root
    .findAll(
      (node) =>
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith(`${prefix}:`) &&
        typeof node.props.onPress === 'function',
    )
    .map((node) => (node.props.testID as string).slice(prefix.length + 1))
    .filter((id, index, all) => all.indexOf(id) === index);
const press = async (root: ReactTestInstance, testID: string) => {
  const node = root.find(
    (n) => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  await act(async () => {
    node.props.onPress();
  });
};
/** The seed every style tile draws from: the face the picker previews. */
const previewSeeds = (root: ReactTestInstance) => [
  ...new Set(
    root
      .findAll(
        (n) =>
          n.props.identity &&
          typeof n.props.style === 'string' &&
          typeof n.props.size === 'number',
      )
      .map((n) => n.props.identity.seed as number),
  ),
];

/** The outline every style tile draws (undefined: the roster body). */
const previewShapes = (root: ReactTestInstance) => [
  ...new Set(
    root
      .findAll((n) => n.props.identity && typeof n.props.style === 'string' && n.props.size === 44)
      .map((n) => n.props.identity.shape),
  ),
];
const noteText = (root: ReactTestInstance) =>
  root.find((n) => n.props.testID === 'bot-face-picker-note' && typeof n.props.children === 'string').props.children;

/** A Bot Session's face editing, wired the way the Session header wires it. */
function SessionHarness(props: Readonly<{ face: SessionBotFaceV1 | null }>) {
  const facts = React.useMemo(
    () => ({ seed: props.face?.seed ?? 'session-1', face: props.face }),
    [props.face],
  );
  const editor = useSessionBotFaceEditor({
    sessionId: 'session-1',
    serverId: 'server-a',
    facts,
  });
  return (
    <BotFacePickerPanel
      seed={editor.shown.seed}
      face={editor.shown.face}
      onChange={editor.change}
      status={editor.status}
    />
  );
}

describe('BotFacePicker', () => {
  it('drops discarded Surprise previews when the panel closes', async () => {
    setAccountStyle('dither');
    const { BotFaceRasterView } = await import('./face/BotFaceRasterView');
    let face: SessionBotFaceV1 | null = null;
    const change = (next: SessionBotFaceV1 | null) => { face = next; };
    const panel = () => <BotFacePickerPanel seed="retention-picker" face={face} onChange={change} />;
    const picker = await renderScreen(panel());
    const shapes: (SessionBotFaceV1 | null)[] = [];
    const drawings: Set<unknown>[] = [];
    for (let step = 0; step < 8; step++) {
      await press(picker, 'bot-face-surprise');
      await picker.update(panel());
      shapes.push(face);
      drawings.push(new Set(picker.findAllByType(BotFaceRasterView).map(node => node.props.image)));
    }
    await picker.unmount();
    for (const [index, saved] of shapes.entries()) {
      face = saved;
      const reopened = await renderScreen(panel());
      for (const node of reopened.findAllByType(BotFaceRasterView)) {
        expect(drawings[index]!.has(node.props.image)).toBe(false);
      }
      await reopened.unmount();
    }
  });

  it('offers Account default beside the protocol styles, bodies and colours', async () => {
    const screen = await renderScreen(
      <BotFacePickerPanel seed="bot-a" face={null} onChange={() => {}} />,
    );
    expect(tileIds(screen.root, 'bot-face-style')).toEqual(
      ['account-default', ...BotFaceStyleSchema.options],
    );
    expect(tileIds(screen.root, 'bot-face-style')[1]).toBe('dither');
    // Every roster body, then Surprise me and Custom (R8: the two shape tiles end the row).
    expect(tileIds(screen.root, 'bot-face-body')).toEqual([
      ...BotFaceBodySchema.options,
      'surprise',
      'custom',
    ]);
    expect(tileIds(screen.root, 'bot-face-colour')).toEqual(
      BotFacePaletteSchema.options,
    );
  });

  it('hides the body choice for Planet, the moon itself', async () => {
    const screen = await renderScreen(
      <BotFacePickerPanel
        seed="bot-a"
        face={{ style: 'planet', seed: 'bot-a' }}
        onChange={() => {}}
      />,
    );
    expect(tileIds(screen.root, 'bot-face-body')).toEqual([]);
  });

  it('saves Surprise me as one session.bot.face.set carrying a new admitted outline, previewed before the save settles', async () => {
    let settle: (value: { ok: true; result: object }) => void = () => {};
    execute.mockReset();
    execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const screen = await renderScreen(
      <SessionHarness face={{ style: 'solid', palette: 'sand' }} />,
    );
    await press(screen.root, 'bot-face-surprise');
    expect(execute).toHaveBeenCalledTimes(1);
    const [actionId, input, context] = execute.mock.calls[0];
    expect(actionId).toBe('session.bot.face.set');
    expect(context).toMatchObject({ serverId: 'server-a' });
    const face = (input as { sessionId: string; face: SessionBotFaceV1 }).face;
    expect(input).toMatchObject({ sessionId: 'session-1' });
    // Only the shape changes: style, colour and the seed the rest is drawn from stay; the outline is saved, not a seed.
    expect(face).toMatchObject({ style: 'solid', palette: 'sand', seed: 'session-1', shape: { v: 1, origin: 'surprise' } });
    expect(normaliseAndValidateBotFaceShape(face.shape!)).toMatchObject({ ok: true });
    expect(previewShapes(screen.root)).toEqual([face.shape]);
    await act(async () => {
      settle({ ok: true, result: {} });
    });
    expect(previewShapes(screen.root)).toEqual([face.shape]);
  });

  it('draws a new shape on every Surprise press, from the tile or the footer: one dice', async () => {
    execute.mockReset();
    execute.mockResolvedValue({ ok: true, result: {} });
    const screen = await renderScreen(<SessionHarness face={null} />);
    await press(screen.root, 'bot-face-body:surprise');
    await press(screen.root, 'bot-face-surprise');
    const shapes = execute.mock.calls.map((call) => (call[1] as { face: SessionBotFaceV1 }).face.shape);
    expect(shapes).toHaveLength(2);
    expect(shapes[0]).not.toEqual(shapes[1]);
    expect(screen.root.findAll((n) => n.props.testID === 'bot-face-another')).toEqual([]);
  });

  it('shows a shape the Bot set as Custom, and a roster body tap returns to that body', async () => {
    execute.mockReset();
    execute.mockResolvedValue({ ok: true, result: {} });
    const custom = { v: 1 as const, fill: ['M20 0 L100 0 L100 80 L20 80 Z'], mouth: [60, 46, 0.8] as [number, number, number], origin: 'custom' as const };
    const screen = await renderScreen(<SessionHarness face={{ seed: 's', shape: custom }} />);
    const selected = screen.root.find((n) => n.props.testID === 'bot-face-body:custom' && typeof n.props.onPress === 'function');
    expect(selected.props.accessibilityState).toMatchObject({ selected: true });
    expect(noteText(screen.root)).toBe('bots.face.customNote');
    await press(screen.root, 'bot-face-body:crab');
    expect(execute.mock.calls.map((call) => call[1])).toEqual([{ sessionId: 'session-1', face: { seed: 's', body: 'crab' } }]);
  });

  it('explains how to get a Custom shape when the Bot has none, without saving anything', async () => {
    execute.mockReset();
    const screen = await renderScreen(<SessionHarness face={{ seed: 's' }} />);
    await press(screen.root, 'bot-face-body:custom');
    expect(execute).not.toHaveBeenCalled();
    expect(noteText(screen.root)).toBe('bots.face.customEmptyNote');
  });

  it('sends null for Use my default, and one commit with the shown seed per body tap', async () => {
    execute.mockReset();
    execute.mockResolvedValue({ ok: true, result: {} });
    const screen = await renderScreen(
      <SessionHarness face={{ style: 'pixel', seed: 'rerolled' }} />,
    );
    await press(screen.root, 'bot-face-body:crab');
    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      {
        sessionId: 'session-1',
        face: { style: 'pixel', body: 'crab', seed: 'rerolled' },
      },
    ]);
    await press(screen.root, 'bot-face-use-default');
    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      {
        sessionId: 'session-1',
        face: { style: 'pixel', body: 'crab', seed: 'rerolled' },
      },
      { sessionId: 'session-1', face: null },
    ]);
  });

  it('reverts a refused save to the saved face and says so in place', async () => {
    execute.mockReset();
    execute.mockResolvedValueOnce({
      ok: false,
      errorCode: 'action_denied',
      error: 'denied',
    } as never);
    const screen = await renderScreen(
      <SessionHarness face={{ seed: 'saved' }} />,
    );
    await press(screen.root, 'bot-face-surprise');
    expect(previewSeeds(screen.root)).toEqual([botFaceSeedNumber('saved')]);
    expect(previewShapes(screen.root)).toEqual([undefined]);
    const note = screen.root.find(
      (n) =>
        n.props.testID === 'bot-face-picker-note' &&
        typeof n.props.children === 'string',
    );
    expect(note.props.children).toBe('bots.face.failed');
  });

  it('draws an inherited face in the Bots default while an explicit per-Bot style keeps its own', async () => {
    setAccountStyle('pixel');
    try {
      const screen = await renderScreen(
        <>
          <SessionBotFace facts={{ seed: 'inherits', face: null }} size={24} testID="inherits" />
          <SessionBotFace facts={{ seed: 'explicit', face: { style: 'solid' } }} size={24} testID="explicit" />
        </>,
      );
      const styleOf = (testID: string) => screen.root.find((n) => n.props?.testID === testID && typeof n.props?.style === "string").props.style;
      expect(styleOf('inherits')).toBe('pixel');
      expect(styleOf('explicit')).toBe('solid');
    } finally {
      setAccountStyle('dither');
    }
  });

  it('shows the inherited default as chosen; re-choosing it saves nothing, another style saves once', async () => {
    setAccountStyle('pixel');
    try {
      const onChange = vi.fn();
      const screen = await renderScreen(<BotFacePickerPanel seed="bot-a" face={null} onChange={onChange} />);
      const tile = (id: string) => screen.root.find((n) => n.props.testID === `bot-face-style:${id}` && typeof n.props.onPress === 'function');
      expect(tile('account-default').props['aria-checked']).toBe(true);
      await press(screen.root, 'bot-face-style:account-default');
      expect(onChange).not.toHaveBeenCalled();
      await press(screen.root, 'bot-face-style:solid');
      expect(onChange.mock.calls).toEqual([[{ style: 'solid', seed: 'bot-a' }]]);
    } finally {
      setAccountStyle('dither');
    }
  });

  it('removes only the style through the face Action, retains the custom identity and follows later Account defaults', async () => {
    execute.mockReset();
    execute.mockResolvedValue({ ok: true, result: {} });
    const shape = { v: 1 as const, fill: ['M20 0 L100 0 L100 80 L20 80 Z'], mouth: [60, 46, 0.8] as [number, number, number], origin: 'custom' as const };
    const face = { style: 'solid' as const, body: 'crab' as const, palette: 'sand' as const, seed: 'kept', shape };
    const screen = await renderScreen(<SessionHarness face={face} />);
    await press(screen.root, 'bot-face-style:account-default');
    const retained = { body: 'crab', palette: 'sand', seed: 'kept', shape };
    expect(execute.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ['session.bot.face.set', { sessionId: 'session-1', face: retained }],
    ]);
    expect(previewShapes(screen.root)).toEqual([shape]);
    expect(previewSeeds(screen.root)).toEqual([botFaceSeedNumber('kept')]);
    const saved = execute.mock.calls[0]![1] as { face: SessionBotFaceV1 };
    setAccountStyle('pixel');
    try {
      await screen.update(<SessionBotFace facts={{ seed: 'kept', face: saved.face }} size={24} testID="inherited" />);
      const drawn = () => screen.root.find(n => n.props.testID === 'inherited' && typeof n.props.style === 'string').props;
      expect(drawn()).toMatchObject({ style: 'pixel', identity: { body: 'crab', colour: 'sand', seed: botFaceSeedNumber('kept'), shape } });
      setAccountStyle('dots');
      expect(drawn()).toMatchObject({ style: 'dots', identity: { body: 'crab', colour: 'sand', seed: botFaceSeedNumber('kept'), shape } });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      setAccountStyle('dither');
    }
  });
});
