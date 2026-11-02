import * as React from 'react';
import { Group, Picture, Skia, createPicture, type SkImage } from '@shopify/react-native-skia';
import type { ImageMarkV1, ImageRectV1 } from '@happier-dev/protocol';

import { drawMarkGeometry } from './drawMarkSkia.native';
import { rasterizeBlurPreview } from './flattenImage.native';
import { cropOverlayPaths, getMarkGeometry } from './markGeometry';
import { measureMarkText } from './markTextFont.native';
import type { ImageAnnotationSource } from './types';

type MovingTransform = React.ComponentProps<typeof Group>['transform'];
type BlurMark = Extract<ImageMarkV1, { kind: 'blur' }>;

const SourcePicture = React.memo(function SourcePicture(props: Readonly<{ image: SkImage; source: ImageAnnotationSource }>) {
  const { image, source } = props;
  const picture = React.useMemo(() => createPicture(canvas => {
    canvas.drawImageRect(image, Skia.XYWHRect(0, 0, image.width(), image.height()),
      Skia.XYWHRect(0, 0, source.width, source.height), Skia.Paint());
  }, source), [image, source]);
  return <Picture picture={picture} />;
});

/** Each mounted blur owns its raster, keyed by the document owner's stable mark/source identities. */
const BlurPicture = React.memo(function BlurPicture(props: Readonly<{
  mark: BlurMark; source: ImageAnnotationSource; movingTransform?: MovingTransform;
}>) {
  const { mark, source } = props;
  const [raster, setRaster] = React.useState<Readonly<{ mark: BlurMark; source: ImageAnnotationSource; image: SkImage | null }> | null>(null);
  React.useEffect(() => {
    let alive = true;
    void rasterizeBlurPreview(source, mark.rect, mark.size).then(result => {
      if (!alive) return;
      const image = result.ok ? Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(result.png)) : null;
      setRaster({ mark, source, image });
    });
    return () => { alive = false; };
  }, [mark, source]);
  const image = raster?.mark === mark && raster.source === source ? raster.image : null;
  const picture = React.useMemo(() => image ? createPicture(canvas => {
    canvas.drawImageRect(image, Skia.XYWHRect(0, 0, image.width(), image.height()),
      Skia.XYWHRect(mark.rect.x, mark.rect.y, mark.rect.width, mark.rect.height), Skia.Paint());
  }, source) : null, [image, mark, source]);
  return picture ? <Group transform={props.movingTransform}><Picture picture={picture} /></Group> : null;
});

const VectorPicture = React.memo(function VectorPicture(props: Readonly<{
  mark: Exclude<ImageMarkV1, BlurMark>; source: ImageAnnotationSource; stepNumber?: number; movingTransform?: MovingTransform;
}>) {
  const { mark, source, stepNumber } = props;
  const picture = React.useMemo(() => createPicture(canvas => {
    drawMarkGeometry(canvas, getMarkGeometry(mark, source.scale, stepNumber, measureMarkText));
  }, source), [mark, source, stepNumber]);
  return <Group transform={props.movingTransform}><Picture picture={picture} /></Group>;
});

const CropCover = React.memo(function CropCover(props: Readonly<{ crop: ImageRectV1; source: ImageAnnotationSource; color: string }>) {
  const { crop, source, color } = props;
  const picture = React.useMemo(() => createPicture(canvas => {
    const outside = Skia.Path.MakeFromSVGString(cropOverlayPaths(crop, source, 0).scrim);
    if (!outside) return;
    outside.setFillType(1);
    outside.setIsVolatile(false);
    const paint = Skia.Paint();
    paint.setColor(Skia.Color(color));
    canvas.drawPath(outside, paint);
  }, source), [color, crop, source]);
  return <Picture picture={picture} />;
});

/** One native scene: source, all blur rasters (including moved ones), then document-ordered vectors. */
export function NativeAnnotationScene(props: Readonly<{
  image: SkImage; source: ImageAnnotationSource; marks: readonly ImageMarkV1[];
  fit: number; fontReady: boolean; numbers: Readonly<Record<string, number>>;
  movingId: string | null; movingTransform: MovingTransform; textEditId?: string;
  crop: ImageRectV1 | null; backgroundColor: string;
}>) {
  const transform = React.useMemo(() => [{ scale: props.fit }], [props.fit]);
  return <Group transform={transform}>
    <SourcePicture image={props.image} source={props.source} />
    {props.marks.map(mark => mark.kind === 'blur' ? <BlurPicture key={mark.id} mark={mark} source={props.source}
      movingTransform={mark.id === props.movingId ? props.movingTransform : undefined} /> : null)}
    {props.fontReady ? props.marks.map(mark => mark.kind !== 'blur' && mark.id !== props.textEditId
      ? <VectorPicture key={mark.id} mark={mark} source={props.source} stepNumber={props.numbers[mark.id]}
        movingTransform={mark.id === props.movingId ? props.movingTransform : undefined} /> : null) : null}
    {props.crop ? <CropCover crop={props.crop} source={props.source} color={props.backgroundColor} /> : null}
  </Group>;
}
