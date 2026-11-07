type Materialization = Readonly<{ activeServerDir: string }>;
type Listener = (materialization: Materialization) => Promise<void>;

const listeners = new Set<Listener>();

export function subscribeProviderAccountSettingsMaterializations(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function notifyProviderAccountSettingsMaterialized(materialization: Materialization): Promise<void> {
  await Promise.all([...listeners].map(listener => listener(materialization)));
}
