import * as React from 'react';
import { createRoot } from 'react-dom/client';
import {
  ATMOSPHERE_PALETTE,
  ATMOSPHERE_PICTURES,
  lookFor,
} from '@happier-dev/brand/atmosphere';
import { BackdropCanvas } from '@/components/atmosphere/BackdropCanvas.web';
import { atmosphereResettleFact } from '@/components/atmosphere/atmosphereStage';
import { builtinPictureLocalId } from '@/components/atmosphere/ensureBuiltinPicture';
import { pictureBackdropProps } from '@/components/atmosphere/pictureBackdrop';
import type { PictureRecord } from '@/components/atmosphere/pictureStore.types';
type Theme = 'light' | 'dark';
const mount = document.getElementById('product');
if (!mount) throw new Error('Missing harness mount');
const root = createRoot(mount);
const pageOf = (theme: Theme) => ATMOSPHERE_PALETTE.page[theme];

async function pictureRecord(id: string, file: string): Promise<PictureRecord> {
  const blob = await (await fetch(file)).blob();
  return {
    localId: builtinPictureLocalId(id),
    kind: 'builtin',
    createdAtMs: 0,
    size: blob.size,
    data: blob,
  };
}

function Band(
  props: Readonly<{
    source: PictureRecord;
    id: string;
    theme: Theme;
    width: number;
    height: number;
    onReady: () => void;
  }>,
) {
  const picture =
    ATMOSPHERE_PICTURES.find((entry) => entry.id === props.id) ?? null;
  const job = pictureBackdropProps({
    picture,
    look: lookFor(props.id),
    theme: props.theme,
    page: props.theme === 'dark' ? [19, 17, 17] : [245, 245, 245],
    layout: 'horizon',
    horizonAt: picture?.horizon.at ?? 0.6,
  });
  return (
    <BackdropCanvas
      source={props.source}
      size={{ width: props.width, height: props.height }}
      {...job}
      onReady={props.onReady}
    />
  );
}

const harness = {
  async resettleMount(
    input: Readonly<{
      theme: Theme;
      width: number;
      height: number;
      fromId: string;
      fromFile: string;
    }>,
  ) {
    document.body.style.background = pageOf(input.theme);
    const source = await pictureRecord(input.fromId, input.fromFile);
    await new Promise<void>((resolve) =>
      root.render(
        <Band
          source={source}
          id={input.fromId}
          theme={input.theme}
          width={input.width}
          height={input.height}
          onReady={resolve}
        />,
      ),
    );
  },
  async resettleTo(
    input: Readonly<{
      theme: Theme;
      width: number;
      height: number;
      toId: string;
      toFile: string;
      reducedMotion?: boolean;
    }>,
  ) {
    const source = await pictureRecord(input.toId, input.toFile);
    atmosphereResettleFact.announce(
      source.localId,
      input.reducedMotion === true,
    );
    await new Promise<void>((resolve) =>
      root.render(
        <Band
          source={source}
          id={input.toId}
          theme={input.theme}
          width={input.width}
          height={input.height}
          onReady={resolve}
        />,
      ),
    );
  },
  unmount() {
    root.unmount();
  },
};

declare global {
  interface Window {
    U9H: typeof harness;
  }
}
window.U9H = harness;
