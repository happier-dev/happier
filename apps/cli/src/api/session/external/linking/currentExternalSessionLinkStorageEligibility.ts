export function isCurrentExternalSessionLinkStorageState(
  value: unknown,
  options: Readonly<{ allowReleasedServerOmission?: boolean }> = {},
): boolean {
  // Stable server-v0.2.1 (4913c1e…) and preview server-v0.2.2
  // (24b6016…) predate non-hosted storage states and omit this field on
  // by-id reads. The new exact lookup route always projects the field, so its
  // caller leaves this compatibility direction disabled.
  if (value === undefined) {
    return options.allowReleasedServerOmission === true;
  }
  return (
    value === 'machine_only'
    || value === 'server_partial'
    || value === 'snapshot_complete'
    || value === 'legacy_external_unknown'
  );
}
