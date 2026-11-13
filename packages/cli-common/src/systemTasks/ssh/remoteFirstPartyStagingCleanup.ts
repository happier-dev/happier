/** Remove only transfer staging; a cleanup refusal must not change the install result. */
export function buildRemoteFirstPartyStagingCleanupCommand(stagePathExpression: string): string {
  return `if ! (find ${stagePathExpression} -type d -exec chmod u+w {} + && rm -rf ${stagePathExpression}) 2>/dev/null; then printf '%s\\n' 'Warning: Happier installation staging cleanup failed; temporary files remain.' >&2; fi`;
}
