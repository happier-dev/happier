import * as React from 'react';
import { botFaceArtHash } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';

import { resolveBotFaceArt, type BotFaceIdentity } from './botFaceIdentity';
import { drawBotFaceRaster, type BotFaceRasterImage, type BotFaceRasterInput } from './botFaceRaster';

type Drawings = { consumers: number; images: Map<string, BotFaceRasterImage> };
const liveDrawings = new Map<string, Drawings>();

/** Quantised poses are shared by live faces of the same artwork and colour, then released with the last face. */
export function useBotFaceDrawings(identity: BotFaceIdentity): (input: BotFaceRasterInput) => BotFaceRasterImage {
  const key = `${identity.colour}|${botFaceArtHash(resolveBotFaceArt(identity))}`;
  const drawing = React.useMemo(() => {
    // Uncommitted renders own their drawing locally; they cannot retain discarded artwork in the shared map.
    const owner = { current: liveDrawings.get(key) ?? { consumers: 0, images: new Map<string, BotFaceRasterImage>() } };
    return { owner, draw: (input: BotFaceRasterInput) => drawListRaster(owner.current.images, input) };
  }, [key]);
  React.useLayoutEffect(() => {
    const shared = liveDrawings.get(key) ?? drawing.owner.current;
    drawing.owner.current = shared;
    shared.consumers++;
    liveDrawings.set(key, shared);
    return () => {
      if (--shared.consumers === 0) liveDrawings.delete(key);
    };
  }, [key, drawing]);
  return drawing.draw;
}

function drawListRaster(drawings: Map<string, BotFaceRasterImage>, input: BotFaceRasterInput): BotFaceRasterImage {
  const m = input.moment;
  const key = [input.style, input.size, input.dpr, input.theme, input.mood, input.monochrome ? 1 : 0, input.look ?? 0, input.mutter ?? '',
    m ? [m.from, m.to, m.u, m.pad, m.channels.tx, m.channels.ty, m.channels.sx, m.channels.sy, m.channels.rot, m.turn?.yaw, m.turn?.pitch, m.turn?.roll].join(',') : ''].join('|');
  let image = drawings.get(key);
  if (!image) { image = drawBotFaceRaster(input); drawings.set(key, image); }
  return image;
}
