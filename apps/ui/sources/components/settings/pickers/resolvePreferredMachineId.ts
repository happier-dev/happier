function normalizeId(value: unknown): string {
  return String(value ?? '').trim();
}

export function resolvePreferredMachineId(params: Readonly<{ machines: any[]; recentMachinePaths: any[] }>): string | null {
  const machines = Array.isArray(params.machines) ? params.machines : [];
  const recentMachinePaths = Array.isArray(params.recentMachinePaths) ? params.recentMachinePaths : [];

  const recent = recentMachinePaths[0] ?? null;
  const recentMachineId = normalizeId(recent?.machineId);
  if (recentMachineId && machines.some((m) => normalizeId(m?.id) === recentMachineId)) return recentMachineId;
  return normalizeId(machines?.[0]?.id) || null;
}

