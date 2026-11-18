package dev.happier.composerinput

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.ReplacementSpan
import kotlin.math.ceil
import kotlin.math.max

internal data class ComposerReference(
  val ref: String,
  val label: String,
  val kind: String,
  val state: String,
  val glyph: String?,
  val accessibilityLabel: String,
  val marker: String,
  val source: String,
)

internal data class ComposerChipStyle(
  val foreground: Int,
  val background: Int,
  val warning: Int,
  val muted: Int,
  val selection: Int,
  val height: Float,
  val radius: Float,
  val maxLabelWidth: Float,
  val typeface: Typeface?,
  val paddingLeft: Float,
  val paddingRight: Float,
  val glyphSize: Float,
  val gap: Float,
  val glyphForeground: Int,
  val warningGlyphForeground: Int,
  val maxWidth: Float,
)

/** The Editable retains its original UTF-16 characters; only their presentation changes. */
internal class ComposerChipSpan(
  val reference: ComposerReference,
  private val style: () -> ComposerChipStyle,
  private val selected: () -> Boolean,
) : ReplacementSpan() {
  init {
    if (Build.VERSION.SDK_INT >= 30) contentDescription = reference.accessibilityLabel
  }

  private fun label(paint: Paint): String {
    val tokens = style()
    val chrome = tokens.paddingLeft + tokens.paddingRight + tokens.glyphSize + tokens.gap
    val available = minOf(tokens.maxLabelWidth, (tokens.maxWidth - chrome).coerceAtLeast(0f))
    return TextUtils.ellipsize(reference.label, TextPaint(paint).apply { typeface = tokens.typeface }, available, TextUtils.TruncateAt.END).toString()
  }

  override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
    val metrics = paint.fontMetricsInt
    val height = max(style().height, (metrics.descent - metrics.ascent).toFloat())
    fm?.apply {
      ascent = minOf(metrics.ascent, -ceil((height - metrics.descent + metrics.ascent) / 2 - metrics.ascent).toInt())
      descent = ascent + ceil(height).toInt()
      top = minOf(metrics.top, ascent)
      bottom = maxOf(metrics.bottom, descent)
      leading = metrics.leading
    }
    val tokens = style()
    return minOf(tokens.maxWidth.toInt(), ceil(Paint(paint).apply { typeface = tokens.typeface }.measureText(label(paint)) + tokens.paddingLeft + tokens.paddingRight + tokens.glyphSize + tokens.gap).toInt())
  }

  override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
    val width = getSize(paint, text, start, end, null).toFloat()
    val save = canvas.save()
    canvas.clipRect(x, top.toFloat(), x + width, bottom.toFloat())
    drawQuietInkChip(canvas, paint, label(paint), reference.glyph ?: "", x, y.toFloat(), width, style(), reference.state, selected())
    canvas.restoreToCount(save)
  }
}

/** One token-driven drawing seam for the composer surface's native art direction. */
private fun drawQuietInkChip(
  canvas: Canvas, sourcePaint: Paint, label: String, glyph: String, x: Float, baseline: Float,
  width: Float, style: ComposerChipStyle, state: String, selected: Boolean,
) {
  val paint = Paint(sourcePaint).apply { isAntiAlias = true }
  paint.typeface = style.typeface
  val metrics = paint.fontMetrics
  val height = max(style.height, metrics.descent - metrics.ascent)
  val center = baseline + (metrics.ascent + metrics.descent) / 2
  val bounds = RectF(x, center - height / 2, x + width, center + height / 2)
  paint.color = style.background
  canvas.drawRoundRect(bounds, style.radius, style.radius, paint)
  if (selected) {
    paint.color = style.selection
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = sourcePaint.textSize / 14
    canvas.drawRoundRect(bounds, style.radius, style.radius, paint)
    paint.style = Paint.Style.FILL
  }
  paint.color = when (state) {
    "removed", "unavailable" -> style.warning
    "pending", "pending-upload", "uploading" -> style.muted
    else -> style.foreground
  }
  val glyphPaint = Paint(paint).apply {
    textSize = style.glyphSize
    typeface = Typeface.DEFAULT
    color = when (state) {
      "removed", "unavailable" -> style.warningGlyphForeground
      "ready" -> style.glyphForeground
      else -> paint.color
    }
  }
  canvas.drawText(glyph, x + style.paddingLeft, center - (glyphPaint.fontMetrics.ascent + glyphPaint.fontMetrics.descent) / 2, glyphPaint)
  canvas.drawText(label, x + style.paddingLeft + style.glyphSize + style.gap, baseline, paint)
}
