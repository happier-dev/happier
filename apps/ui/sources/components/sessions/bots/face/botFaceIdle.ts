import { botFaceMotionTokens, type BotFaceIdleGesture } from './botFaceMotionTokens';

/** One clock for all mounted resting rail faces, regardless of which rail/roster surface hosts them. */
const resting = new Map<(gesture: BotFaceIdleGesture) => void, unknown>();
let timer: ReturnType<typeof setTimeout> | null = null;
let lastBot: unknown;
let lastGesture: BotFaceIdleGesture | undefined;
let lastReactionAt = -Infinity;
const gestures = Object.keys(botFaceMotionTokens.idle) as BotFaceIdleGesture[];

export function noteBotFaceReaction(): void { lastReactionAt = Date.now(); }

function schedule(delay = botFaceMotionTokens.scheduler.firstAfterMs as number) {
  if (timer !== null || resting.size === 0) return;
  timer = setTimeout(() => {
    timer = null;
    if (Date.now() - lastReactionAt < botFaceMotionTokens.scheduler.quietAfterReactionMs) {
      schedule(1000); // R7's quiet-window retry; never wakes without an eligible resting face.
      return;
    }
    const candidates = [...resting].filter(([, bot]) => bot !== lastBot);
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    if (next) {
      const choices = gestures.filter(gesture => gesture !== lastGesture);
      const gesture = choices[Math.floor(Math.random() * choices.length)]!;
      lastBot = next[1]; lastGesture = gesture;
      next[0](gesture);
    }
    const [min, max] = botFaceMotionTokens.scheduler.everyMs;
    schedule(min + Math.random() * (max - min));
  }, delay);
}

/** Only eligible Lively faces register; removing the last one removes the clock itself. */
export function registerRestingBotFace(onIdle: (gesture: BotFaceIdleGesture) => void, bot: unknown = onIdle): () => void {
  resting.set(onIdle, bot);
  schedule();
  return () => {
    resting.delete(onIdle);
    if (resting.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
      lastBot = undefined;
      lastGesture = undefined;
    }
  };
}
