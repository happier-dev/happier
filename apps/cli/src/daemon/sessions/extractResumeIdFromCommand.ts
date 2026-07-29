/**
 * Extract the provider resume identity from a live runner command.
 *
 * Marker adoption and markerless recovery share this parser so legacy runners
 * cannot lose restartability because the two recovery paths interpret argv
 * differently.
 */
export function extractResumeIdFromCommand(command: string): string | null {
  const match = /(?:^|\s)--resume(?:=|\s+)(\S+)/.exec(command);
  const resumeId = typeof match?.[1] === 'string' ? match[1].trim() : '';
  return resumeId || null;
}
