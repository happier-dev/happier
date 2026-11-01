import { vi } from 'vitest';

// Real web recognizers need the browser platform, including its touchables.
// Override the ordinary Node-suite boundary once for every gesture-web suite.
vi.mock('react-native', async () => await vi.importActual('react-native-web'));
