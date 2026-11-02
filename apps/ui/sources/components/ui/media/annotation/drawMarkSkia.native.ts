import { BlendMode, PaintStyle, Skia, StrokeCap, StrokeJoin, type SkCanvas } from '@shopify/react-native-skia';

import type { MarkGeometry } from './markGeometry';
import { markFont } from './markTextFont.native';

/** One mark's geometry on a Skia canvas: the live canvas and the flatten draw through this, so preview is export. */
export function drawMarkGeometry(canvas: SkCanvas, geometry: MarkGeometry): void {
  for (const path of geometry.paths) {
    const shape = Skia.Path.MakeFromSVGString(path.d);
    if (!shape) continue;
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setAlphaf(path.opacity ?? 1);
    if (path.blendMode === 'multiply') paint.setBlendMode(BlendMode.Multiply);
    if (path.fill) {
      paint.setStyle(PaintStyle.Fill);
      paint.setColor(Skia.Color(path.fill));
      paint.setAlphaf(path.opacity ?? 1);
      canvas.drawPath(shape, paint);
    }
    if (path.stroke) {
      paint.setStyle(PaintStyle.Stroke);
      paint.setColor(Skia.Color(path.stroke));
      paint.setAlphaf(path.opacity ?? 1);
      paint.setStrokeWidth(path.strokeWidth ?? 1);
      paint.setStrokeCap(StrokeCap.Round);
      paint.setStrokeJoin(StrokeJoin.Round);
      canvas.drawPath(shape, paint);
    }
  }
  for (const text of geometry.texts) {
    const font = markFont(text.fontSize);
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setColor(Skia.Color(text.color));
    const x = text.align === 'center' ? text.x - font.getTextWidth(text.text) / 2 : text.x;
    canvas.drawText(text.text, x, text.y, paint, font);
  }
}
