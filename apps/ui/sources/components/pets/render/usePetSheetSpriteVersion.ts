import * as React from 'react';
import { Image } from 'react-native';
import type { ImageProps } from 'expo-image';
import {
  getPetAtlasForDimensionsV1,
  PET_ATLAS_V2,
} from '@happier-dev/protocol/pets/constants';

type SheetVersion = 1 | 2 | null;

/** Decoded sizes are facts of the sheet's bytes: one read per sheet URL per app run. */
const decoded = new Map<string, Promise<SheetVersion>>();

function readSheetVersion(uri: string): Promise<SheetVersion> {
  const held = decoded.get(uri);
  if (held) return held;
  const read = new Promise<SheetVersion>((resolve) => {
    Image.getSize(
      uri,
      (width, height) => {
        const atlas = getPetAtlasForDimensionsV1(width, height);
        resolve(atlas === null ? null : atlas === PET_ATLAS_V2 ? 2 : 1);
      },
      () => resolve(null),
    );
  });
  decoded.set(uri, read);
  return read;
}

function sheetUri(source: ImageProps['source']): string | null {
  return source &&
    typeof source === 'object' &&
    !Array.isArray(source) &&
    'uri' in source &&
    typeof source.uri === 'string'
    ? source.uri
    : null;
}

/**
 * A pet sheet's atlas version (v1 or v2): an authoritative value (a built-in's atlas, the server's for an Account pet) as
 * given, otherwise from the sheet's decoded dimensions. A registry's own version label is never trusted (Boba is
 * labelled 1 and is a 1536 × 2288 sheet). `undefined` while the sheet is being read; `null` when it is not a pet atlas.
 */
export function usePetSheetSpriteVersion(
  source: ImageProps['source'],
  authoritative: 1 | 2 | undefined,
): SheetVersion | undefined {
  const uri = authoritative === undefined ? sheetUri(source) : null;
  const [read, setRead] = React.useState<Readonly<{
    uri: string;
    version: SheetVersion;
  }> | null>(null);
  React.useEffect(() => {
    if (!uri) return;
    let active = true;
    void readSheetVersion(uri).then((version) => {
      if (active) setRead({ uri, version });
    });
    return () => {
      active = false;
    };
  }, [uri]);
  if (authoritative !== undefined) return authoritative;
  if (!uri) return 1;
  return read?.uri === uri ? read.version : undefined;
}
