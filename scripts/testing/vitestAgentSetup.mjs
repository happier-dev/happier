import { installTestHomeEnvironment } from './testHomeEnvironment.mjs';

const home = installTestHomeEnvironment({ isolateExecutables: true });
const { afterAll } = await import('vitest');
afterAll(home.cleanup);
