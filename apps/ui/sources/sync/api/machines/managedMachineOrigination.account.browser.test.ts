import { registerManagedAccountHostTests } from './managedMachineOrigination.account.composed.fixture';

// Runtime HTTP host selection is process-wide; each platform needs its own module graph.
registerManagedAccountHostTests('browser');
