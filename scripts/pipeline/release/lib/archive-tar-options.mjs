// @ts-check

export function resolveTarCreateArgs({
  isGnuTar,
  excludeArgs,
  artifactArg,
  sourceDirArg,
  sourceNameArg,
  compressed,
}) {
  const modeArg = compressed ? '-czf' : '-cf';
  if (isGnuTar) {
    return [
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      ...excludeArgs,
      modeArg,
      artifactArg,
      '-C',
      sourceDirArg,
      sourceNameArg,
    ];
  }
  return [
    '--no-mac-metadata',
    '--uid',
    '0',
    '--gid',
    '0',
    '--numeric-owner',
    ...excludeArgs,
    modeArg,
    artifactArg,
    '-C',
    sourceDirArg,
    sourceNameArg,
  ];
}
