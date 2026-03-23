import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const ensureJavaScriptRuntimeExecutableMock = vi.fn(async () => '/managed/js-runtime');

vi.mock('./query', () => ({
  query: queryMock,
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

function createQueryResult() {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'system',
        subtype: 'init',
        tools: ['read'],
        slash_commands: ['/help'],
      };
    },
  };
}

describe('extractSDKMetadata', () => {
  beforeEach(() => {
    queryMock.mockReset();
    ensureJavaScriptRuntimeExecutableMock.mockReset();
    ensureJavaScriptRuntimeExecutableMock.mockResolvedValue('/managed/js-runtime');
    queryMock.mockReturnValue(createQueryResult());
  });

  it('bootstraps the managed JavaScript runtime before starting the SDK metadata query', async () => {
    const { extractSDKMetadata } = await import('./metadataExtractor');

    const metadata = await extractSDKMetadata();

    expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          executable: '/managed/js-runtime',
        }),
      }),
    );
    expect(metadata).toEqual({
      tools: ['read'],
      slashCommands: ['/help'],
    });
  });
});
