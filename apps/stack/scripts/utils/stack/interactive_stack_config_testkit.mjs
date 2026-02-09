export function mkRl(answers = []) {
  let index = 0;
  return {
    question: async () => {
      const value = answers[index] ?? '';
      index += 1;
      return String(value);
    },
  };
}

export function createInteractiveStackConfigDeps(overrides = {}) {
  return {
    promptSelect: async (_rl, { options, defaultIndex = 0 }) => options?.[defaultIndex]?.value,
    promptWorktreeSource: async () => 'default',
    ...overrides,
  };
}
