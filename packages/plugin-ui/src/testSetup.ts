import { afterAll, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalConsoleError = console.error;

const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: Parameters<typeof console.error>) => {
  if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
    return;
  }
  originalConsoleError(...args);
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
});
