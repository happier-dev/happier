package dev.happier.horizontaloverflowcontainer

import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs

/** Keeps the native vertical transcript list from stealing horizontal overflow drags. */
internal class HappierHorizontalOverflowContainerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private var downX = 0f
  private var downY = 0f
  private var axisDecided = false
  private var parentDisallowed = false

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = event.x
        downY = event.y
        axisDecided = false
        // The framework clears every ancestor's disallow flag on DOWN, and an UP is not seen here once
        // the inner scroller has claimed the drag, so always re-assert rather than trusting the cache.
        parentDisallowed = canChildScrollEitherDirection()
        if (parentDisallowed) parent?.requestDisallowInterceptTouchEvent(true)
      }
      MotionEvent.ACTION_MOVE -> if (!axisDecided) {
        val dx = event.x - downX
        val dy = event.y - downY
        if (maxOf(abs(dx), abs(dy)) > touchSlop) {
          axisDecided = true
          val horizontal = abs(dx) * HORIZONTAL_BIAS > abs(dy)
          setParentDisallowed(horizontal && canChildScrollInFingerDirection(dx))
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        setParentDisallowed(false)
        axisDecided = false
      }
    }
    return false
  }

  private fun horizontalChild(): View? = firstChild(this)

  private fun firstChild(view: ViewGroup): View? {
    for (index in 0 until view.childCount) {
      val child = view.getChildAt(index)
      if (child.canScrollHorizontally(-1) || child.canScrollHorizontally(1)) return child
      if (child is ViewGroup) firstChild(child)?.let { return it }
    }
    return null
  }

  private fun canChildScrollEitherDirection(): Boolean {
    val child = horizontalChild() ?: return false
    return child.canScrollHorizontally(-1) || child.canScrollHorizontally(1)
  }

  private fun canChildScrollInFingerDirection(dx: Float): Boolean {
    val child = horizontalChild() ?: return false
    return child.canScrollHorizontally(if (dx > 0) -1 else 1)
  }

  private fun setParentDisallowed(disallowed: Boolean) {
    if (parentDisallowed == disallowed) return
    parentDisallowed = disallowed
    parent?.requestDisallowInterceptTouchEvent(disallowed)
  }

  private companion object {
    // Accept a modest curve toward vertical: tan(60°) ~= 1.73.
    const val HORIZONTAL_BIAS = 1.7f
  }
}
