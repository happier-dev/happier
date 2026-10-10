import { afterAll, vi } from 'vitest';

// Native SVG is a platform SDK boundary. The RNW project uses its real web shapes instead.
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const shape = (name: string) => (props: Record<string, unknown>) => createElement(name, props);
  const Svg = shape('Svg');
  return { default: Svg, Svg, Path: shape('Path'), Rect: shape('Rect'), Pattern: shape('Pattern'), Defs: shape('Defs') };
});

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
